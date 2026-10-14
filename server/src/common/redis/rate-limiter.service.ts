import { Global, Inject, Injectable, Module } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS_CLIENT } from './redis.constants';
import { RedisModule } from './redis.module';

export interface RateLimitResult {
  allowed: boolean;
  /** 当前窗口内已计数 */
  count: number;
  /** 距窗口重置的秒数 */
  retryAfterSeconds: number;
}

/**
 * 基于 Redis 的固定窗口计数限流。
 *
 * 设计取向：**Redis 不可用时放行**。门户的可用性优先于限流强度——
 * 限流是防爆破/防刷的加固手段，不能因为缓存抖动把业务整体打死。
 *
 * 用 `RateLimiterModule` 注册为全局，任何模块都能直接注入，不必各自 import。
 * （早先它只挂在 AuthModule 下，导致公开接口想限流还得绕一圈。）
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

/**
 * 把限流服务注册为全局模块（依赖 RedisModule 提供 REDIS_CLIENT）。
 * 在 AppModule 里 import 一次即可，其它模块直接注入 `RateLimiterService`。
 */
@Global()
@Module({
  imports: [RedisModule],
  providers: [RateLimiterService],
  exports: [RateLimiterService],
})
export class RateLimiterModule {}
