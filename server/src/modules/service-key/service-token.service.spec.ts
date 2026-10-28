import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'node:crypto';
import { decode } from 'jsonwebtoken';

import { PortalConfigService } from '../../config/portal-config.service';
import { ServiceTokenService } from './service-token.service';

/**
 * 出站服务凭据（门户 → 产品，`docs/27` §3.2）。
 *
 * 云手机侧已按"更严格"的方式实现校验：除了身份 claim，还要求
 * `htm` / `htu` / `qs` / `body_sha256` 与**实际请求**逐字匹配。
 * 门户起初只签了身份（iss/aud），会导致对方每个请求都 1002——
 * 这组用例就是锁定"请求绑定 claim 必须签出来且算对"。
 */
function service(): ServiceTokenService {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const config = {
    jwt: {
      issuer: 'cloud-portal',
      current: { kid: 'portal-2026-10', privateKey, publicKey: '' },
    },
  } as unknown as PortalConfigService;
  /* 只测 claims 构造，不需要真实的签名密钥链 */
  const jwt = new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', issuer: 'cloud-portal', keyid: 'portal-2026-10' },
  });
  return new ServiceTokenService(jwt, config);
}

const claimsOf = (token: string): Record<string, unknown> =>
  decode(token) as Record<string, unknown>;

describe('ServiceTokenService（出站服务凭据）', () => {
  it('带齐请求绑定 claim：htm / htu / qs / body_sha256', async () => {
    const token = await service().issue(
      'phone',
      { method: 'post', path: '/api/internal/provision', bodyText: '{"order_item_id":"281"}' },
      { order_item_id: '281' },
    );
    const c = claimsOf(token);

    expect(c.aud).toBe('phone');
    expect(c.iss).toBe('cloud-portal');
    expect(c.htm).toBe('POST'); // 必须大写，收方按大写比对
    expect(c.htu).toBe('/internal/provision'); // 必须去掉 /api 前缀
    expect(c.qs).toBe('');
    expect(c.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.order_item_id).toBe('281');
  });

  it('qs 按 key 字典序规范化（与验签侧同一套算法）', async () => {
    const token = await service().issue('storage', {
      method: 'GET',
      path: '/api/internal/enterprise-accounts',
      query: 'enterprise_id=3&keyword=li',
    });
    expect(claimsOf(token).qs).toBe('enterprise_id=3&keyword=li');

    const reversed = await service().issue('storage', {
      method: 'GET',
      path: '/api/internal/enterprise-accounts',
      query: 'keyword=li&enterprise_id=3',
    });
    expect(claimsOf(reversed).qs).toBe('enterprise_id=3&keyword=li');
  });

  it('GET 无 body 时不签 body_sha256（收方据此判断"该请求不应该有 body"）', async () => {
    const token = await service().issue('phone', { method: 'GET', path: '/internal/products' });
    expect(claimsOf(token).body_sha256).toBeUndefined();
  });

  it('每次 jti 唯一（否则收方判重放）', async () => {
    const svc = service();
    const binding = { method: 'GET', path: '/internal/products' };
    const [a, b] = await Promise.all([svc.issue('phone', binding), svc.issue('phone', binding)]);
    expect(claimsOf(a).jti).not.toBe(claimsOf(b).jti);
  });

  it('exp - iat = 60 秒', async () => {
    const c = claimsOf(await service().issue('phone', { method: 'GET', path: '/internal/products' }));
    expect(Number(c.exp) - Number(c.iat)).toBe(60);
  });
});
