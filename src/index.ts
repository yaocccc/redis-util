import * as Redis from 'ioredis';
import * as Redlock from 'redlock';

import { unique }  from 'utils';

type KeyType = 'LOCKED' | 'REDLOCK' | 'LIMITER';

/**
    基于Redis的锁实现
    methods:
        getLocked: 获取已锁定列表
        lock: 加锁
        unlock: 解锁
        limit: 限流锁
*/
export class RedisLocker {
    private readonly client: Redis.Redis;
    private readonly redlock: Redlock;
    private readonly NAMESPACE: string;

    constructor(redisClient: Redis.Redis, namespace: string) {
        this.client = redisClient;
        this.redlock = new Redlock([this.client], { retryCount: 100 });
        this.NAMESPACE = namespace;
    }

    private _getKey = (key: string, type: KeyType) => `${this.NAMESPACE}_${type}_${key}`;
    private _getKeysOfType = async (type: KeyType): Promise<string[]> => {
        const pattern = this._getKey('', type);
        return this.client.keys(pattern + '*').then((keys) => keys.map((key) => key.replace(pattern, '')));
    };

    /** 获取锁定键列表 */
    public getLocked = async () => this._getKeysOfType('LOCKED');

    /** 加锁: (键[], 生成期秒) => 锁时间戳凭证 */
    public lock = async (keys: string[], seconds: number): Promise<number | 'LOCKED'> => {
        const lock = Date.now();
        keys = unique(keys.map(key => this._getKey(key, 'LOCKED')));

        const exiteds = await this.client.exists(...keys);
        if (exiteds) return 'LOCKED';

        const pipeline = this.client.pipeline();
        for (const key of keys) {
            pipeline.set(key, lock, 'EX', seconds, 'NX')
        };
        await pipeline.exec();
        return lock;
    };

    /** 解锁: (键[], 锁凭证) => boolean(若有锁凭证则会校验锁凭证是否一致 不一致时返回false) */
    public unlock = async (keys: string[], lock?: number): Promise<boolean> => {
        if (!keys.length) return true;
        keys = unique(keys.map(key => this._getKey(key, 'LOCKED')));

        if (lock !== undefined) {
            const values = await this.client.mget(...keys);
            if (values.some((value) => String(lock) !== value)) return false;
        }
        await this.client.del(...keys);
        return true;
    };

    /** 限流锁: (键, 阈值, 生存期秒数, 锁定秒数) => 当前次数 | LOCKED: 在锁定列表中 | LOCK: 该请求被拦截并添加到了锁定列表 */
    public limit = async (key: string, threshold: number, periodSeconds: number, limitedSeconds: number): Promise<number | 'LOCKED' | 'LOCK'> => {
        const limiter = async () => {
            const lockedKey = this._getKey(key, 'LOCKED');
            const limierKey = this._getKey(key, 'LIMITER');
            const current_score = Date.now();
            const pre_score = current_score - periodSeconds * 1000;

            const limited = await this.client.exists(lockedKey);
            if (limited) return 'LOCKED';

            const [_1, _2, _3, r4]: any[] = await this.client
                .pipeline()
                .zadd(limierKey, current_score, current_score) /** _1: 添加[current_score, current_score]到 zset中 */
                .expire(limierKey, periodSeconds + 1) /** _2: 设置zset生存期 避免冷键占用内存 */
                .zremrangebyscore(limierKey, 0, pre_score) /** _3: 清除zset中从0到pre_score的内容 */
                .zcard(limierKey) /** r4: 获取zset中最新的数据长度 */
                .exec();
            const count: number = r4[1];

            if (count >= threshold) {
                await this.client.set(lockedKey, 1, 'EX', limitedSeconds, 'NX');
                return 'LOCK';
            }
            return count;
        };

        const redlock = await this.redlock.lock(this._getKey(key, 'REDLOCK'), 5000);
        const result = await limiter();
        await this.redlock.unlock(redlock);
        return result;
    };
};
