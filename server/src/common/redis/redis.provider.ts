import { FactoryProvider } from '@nestjs/common';
import Redis from 'ioredis';

import { PortalConfigService } from '../../config/portal-config.service';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Redis 客户端工厂。
 *
 * 放在独立文件而不是 module 装饰器内联：模块文件里内联工厂时，
 * 编译产物会出现「模块文件引用同文件导出的 token」的自引用，
 * Nest 会误报 `A circular dependency has been detected inside RedisModule`
 * （真实成因是 addProvider 收到 undefined）。
 */
export const redisClientProvider: FactoryProvider<Redis> = {
  provide: REDIS_CLIENT,
  inject: [PortalConfigService],
  useFactory: (config: PortalConfigService): Redis => {
    // 同一类错误按时间节流（30s 一条），避免 Redis 长时间不可用时刷屏
    let lastErrorAt = 0;

    const client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      keyPrefix: config.redis.keyPrefix,
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      // 指数退避重连（上限 10s）：Redis 挂掉时不要刷屏，也不要耗尽 CPU
      retryStrategy: (times: number) => Math.min(times * 500, 10_000),
    });
    client.on('error', (error: Error) => {
      // 按「首次 + 之后每 30s 一条」节流：ioredis 的错误文案会随重试次数变化，
      // 按文案去重无效，必须按时间节流（Redis 长时间不可用时不能刷屏）。
      const now = Date.now();
      if (now - lastErrorAt > 30_000) {
        lastErrorAt = now;
        // eslint-disable-next-line no-console
        console.error(`[redis] ${error.message}`);
      }
    });
    return client;
  },
};
