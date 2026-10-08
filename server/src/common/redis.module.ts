import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

import { PortalConfigService } from '../config/portal-config.service';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Redis 客户端（门户用作：refresh 会话、JWT 吊销、限流计数、商品缓存热键）。
 * 注意：Redis 只存易失状态，**不碰任何账务数据**（账务一律 MySQL）。
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [PortalConfigService],
      useFactory: (config: PortalConfigService): Redis => {
        const client = new Redis({
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.db,
          keyPrefix: config.redis.keyPrefix,
          lazyConnect: false,
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
        });
        client.on('error', (error: Error) => {
          // 不抛出：Redis 抖动不应让整个门户 500，由各调用点决定降级策略
          // eslint-disable-next-line no-console
          console.error(`[redis] ${error.message}`);
        });
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
