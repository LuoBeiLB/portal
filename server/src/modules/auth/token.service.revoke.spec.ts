import { createHash } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';

import { RedisStore } from '../../common/redis/redis-store.service';
import { PortalConfigService } from '../../config/portal-config.service';
import { TokenService } from './token.service';

/**
 * access token 的"立即失效"（2026-11-03 新增的用户级作废时刻）。
 *
 * 背景：access token 是无状态的，服务端**没有存**它，所以"删除 access token"没有对象。
 * 只删 refresh 的后果是"管理员重置密码后，员工刷新页面仍是登录态"（最长 2 小时）。
 *
 * 解法：重置时写一个秒级作废时刻，之后每次校验比较 `iat`。
 */
function make(overrides: { values?: Array<string | null> } = {}) {
  const store = {
    getStrings: jest.fn().mockResolvedValue(overrides.values ?? [null, null]),
    setString: jest.fn().mockResolvedValue(undefined),
    smembers: jest.fn().mockResolvedValue([]),
    del: jest.fn().mockResolvedValue(undefined),
    setJson: jest.fn().mockResolvedValue(undefined),
    sadd: jest.fn().mockResolvedValue(undefined),
    srem: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    jwt: {
      issuer: 'cloud-portal',
      accessTtlSeconds: 7200,
      refreshTtlSeconds: 1209600,
      current: { kid: 'portal-2026-10', privateKey: '', publicKey: '' },
    },
  } as unknown as PortalConfigService;

  const service = new TokenService(
    new JwtService({}) as unknown as JwtService,
    store as unknown as RedisStore,
    config,
  );
  return { service, store };
}

const RAW = 'header.payload.signature';
const sha = createHash('sha256').update(RAW).digest('hex');

describe('TokenService.isAccessTokenRevoked（单 token 黑名单 + 用户级作废时刻）', () => {
  it('没有任何标记 → 有效', async () => {
    const { service, store } = make({ values: [null, null] });
    await expect(service.isAccessTokenRevoked(RAW, { sub: 'u1', iat: 1000 })).resolves.toBe(false);

    /* 一次 MGET 拿两个 key，不是两次往返 */
    expect(store.getStrings).toHaveBeenCalledWith([
      `revoked:${sha}`,
      'user:auth-invalid-before:u1',
    ]);
  });

  it('单 token 黑名单命中（登出当前设备）→ 失效', async () => {
    const { service } = make({ values: ['true', null] });
    await expect(service.isAccessTokenRevoked(RAW, { sub: 'u1', iat: 1000 })).resolves.toBe(true);
  });

  it('有毫秒 claim：iam 早于作废时刻 → 失效', async () => {
    const { service } = make({ values: [null, '2000500'] });
    await expect(
      service.isAccessTokenRevoked(RAW, { sub: 'u1', iat: 2000, iam: 2000100 }),
    ).resolves.toBe(true);
  });

  it('有毫秒 claim：同秒内、iam 晚于作废时刻 → 放行（重置后重新登录不被误杀）', async () => {
    const { service } = make({ values: [null, '2000500'] });
    await expect(
      service.isAccessTokenRevoked(RAW, { sub: 'u1', iat: 2000, iam: 2000900 }),
    ).resolves.toBe(false);
  });

  it('同秒边界：重置前签发(iam=2000400) 与作废(2000500) 能分出先后 —— 秒级做不到', async () => {
    const { service } = make({ values: [null, '2000500'] });
    /* 两者 iat 都是 2000，秒级比较会判"相等 → 放行"，那就是漏杀 */
    await expect(
      service.isAccessTokenRevoked(RAW, { sub: 'u1', iat: 2000, iam: 2000400 }),
    ).resolves.toBe(true);
  });

  it('老 token 没有 iam → 回退秒级：作废时刻落在该秒内即吊销（宁可误杀一秒，不漏杀）', async () => {
    const { service } = make({ values: [null, '2000500'] });
    await expect(service.isAccessTokenRevoked(RAW, { sub: 'u1', iat: 2000 })).resolves.toBe(true);
  });

  it('老 token：签发秒早于作废秒 → 失效；晚于 → 放行', async () => {
    const early = make({ values: [null, '2000000'] });
    await expect(early.service.isAccessTokenRevoked(RAW, { sub: 'u1', iat: 1999 })).resolves.toBe(true);

    const later = make({ values: [null, '2000000'] });
    await expect(later.service.isAccessTokenRevoked(RAW, { sub: 'u1', iat: 2001 })).resolves.toBe(false);
  });

  it('token 里没有 iat 但有作废时刻 → 作废（这种 token 本不该存在）', async () => {
    const { service } = make({ values: [null, '2000'] });
    await expect(service.isAccessTokenRevoked(RAW, { sub: 'u1' })).resolves.toBe(true);
  });

  it('作废时刻不是合法数字 → 不因脏数据误杀', async () => {
    const { service } = make({ values: [null, 'not-a-number'] });
    await expect(service.isAccessTokenRevoked(RAW, { sub: 'u1', iat: 1 })).resolves.toBe(false);
  });

  it('拿不到 sub（异常 token）时只查单 token 黑名单，不多查一个 key', async () => {
    const { service, store } = make({ values: [null] });
    await service.isAccessTokenRevoked(RAW, {});
    expect(store.getStrings).toHaveBeenCalledWith([`revoked:${sha}`]);
  });
});

describe('TokenService.revokeAllSessions（吊销 refresh + 写作废时刻）', () => {
  it('写作废时刻的 TTL 覆盖最长 access token，并删掉 refresh 会话', async () => {
    const { service, store } = make();
    store.smembers.mockResolvedValue(['d1', 'd2']);

    const before = Date.now();
    const revoked = await service.revokeAllSessions('u1');
    const after = Date.now();

    /* 返回的是被删掉的 refresh 会话数（沿用原语义，调用方在展示"已下线 N 个会话"） */
    expect(revoked).toBe(2);

    const [markerKey, markerValue, ttl] = store.setString.mock.calls[0];
    expect(markerKey).toBe('user:auth-invalid-before:u1');
    /* 毫秒时间戳：与 token 里的 iam 同精度 */
    expect(Number(markerValue)).toBeGreaterThanOrEqual(before);
    expect(Number(markerValue)).toBeLessThanOrEqual(after);
    expect(Number(markerValue)).toBeGreaterThan(1e12);
    /* accessTtl(7200) + 60 秒余量：保证"作废前签发、但还没过期"的 token 都被覆盖 */
    expect(ttl).toBe(7260);

    expect(store.del).toHaveBeenCalledWith('refresh:d1', 'refresh:d2');
    expect(store.del).toHaveBeenCalledWith('refresh:user:u1');
  });
});
