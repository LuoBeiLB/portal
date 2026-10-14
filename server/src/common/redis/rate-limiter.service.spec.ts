import Redis from 'ioredis';

import { RateLimiterService } from './rate-limiter.service';

/** 用内存 Map 模拟 Redis 的 incr/expire/ttl，验证固定窗口计数语义 */
function fakeRedis(): Redis {
  const store = new Map<string, { count: number; ttl: number }>();
  return {
    incr: (key: string) => {
      const item = store.get(key) ?? { count: 0, ttl: 0 };
      item.count += 1;
      store.set(key, item);
      return Promise.resolve(item.count);
    },
    expire: (key: string, seconds: number) => {
      const item = store.get(key);
      if (item) item.ttl = seconds;
      return Promise.resolve(1);
    },
    ttl: (key: string) => Promise.resolve(store.get(key)?.ttl ?? -1),
  } as unknown as Redis;
}

describe('RateLimiterService（登录/注册限流）', () => {
  it('窗口内未超限时放行并累计计数', async () => {
    const limiter = new RateLimiterService(fakeRedis());
    const first = await limiter.hit('login:1.2.3.4', 60, 3);
    const second = await limiter.hit('login:1.2.3.4', 60, 3);
    expect(first.allowed).toBe(true);
    expect(first.count).toBe(1);
    expect(second.allowed).toBe(true);
    expect(second.count).toBe(2);
  });

  it('超过上限后拒绝，并给出 retry_after', async () => {
    const limiter = new RateLimiterService(fakeRedis());
    await limiter.hit('login:5.6.7.8', 60, 2);
    await limiter.hit('login:5.6.7.8', 60, 2);
    const third = await limiter.hit('login:5.6.7.8', 60, 2);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBe(60);
  });

  it('不同维度（IP / 场景）互不影响', async () => {
    const limiter = new RateLimiterService(fakeRedis());
    await limiter.hit('login:1.1.1.1', 60, 1);
    const otherIp = await limiter.hit('login:2.2.2.2', 60, 1);
    const otherScope = await limiter.hit('register:1.1.1.1', 60, 1);
    expect(otherIp.allowed).toBe(true);
    expect(otherScope.allowed).toBe(true);
  });

  it('Redis 故障时放行（可用性优先，限流只是加固手段）', async () => {
    const broken = {
      incr: () => Promise.reject(new Error('ECONNREFUSED')),
    } as unknown as Redis;
    const limiter = new RateLimiterService(broken);
    const result = await limiter.hit('login:9.9.9.9', 60, 1);
    expect(result.allowed).toBe(true);
  });
});
