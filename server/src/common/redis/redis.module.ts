import { Global, Module } from '@nestjs/common';

import { REDIS_CLIENT } from './redis.constants';
import { redisClientProvider } from './redis.provider';
import { RedisStore } from './redis-store.service';

/**
 * Redis 客户端（门户用作：refresh 会话、JWT 吊销、限流计数、商品缓存热键）。
 * 注意：Redis 只存易失状态，**不碰任何账务数据**（账务一律 MySQL）。
 */
@Global()
@Module({
  providers: [redisClientProvider, RedisStore],
  exports: [REDIS_CLIENT, RedisStore],
})
export class RedisModule {}
