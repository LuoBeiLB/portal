import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS_CLIENT } from './redis.constants';

export interface RateLimitResult {
  allowed: boolean;
  /** 当前窗口内已计数 */
  count: number;
  /** 距窗口重置的秒数 */
  retryAfterSeconds: number;
}

/**
 * 基于 Redis 的固定窗口计数限流（登录/注册用）。
 *
 * 设计取向：**Redis 不可用时放行**。门户的可用性优先于限流强度——
 * 限流是防爆破的加固手段，不能因为缓存抖动把登录整体打死。
 */
@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async hit(key: string, windowSeconds: number, max: number): Promise<RateLimitResult> {
    const redisKey = `rl:${key}`;
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.expire(redisKey, windowSeconds);
      }
      if (count > max) {
        const ttl = await this.redis.ttl(redisKey);
        return { allowed: false, count, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
      }
      return { allowed: true, count, retryAfterSeconds: 0 };
    } catch {
      return { allowed: true, count: 0, retryAfterSeconds: 0 };
    }
  }
}
