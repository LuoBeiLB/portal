import { generateKeyPairSync } from 'node:crypto';

import { JwksService, kidFingerprint, toJwk } from './jwks.service';
import { ServiceKeyService } from '../service-key/service-key.service';
import { ServiceKey } from '../service-key/service-key.service';

function keyPair(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/**
 * `docs/27` 之后 JWKS 不再从配置读公钥，而是从 `ServiceKeyService`（`p_service_key` 表）取。
 * 这里用假缓存驱动，验证输出结构与"只吐 portal 主体"的过滤。
 */
function serviceWith(keys: ServiceKey[]): JwksService {
  const fake = {
    jwks: () => ({
      keys: keys
        .filter((k) => k.ownerCode === 'portal')
        .map((k) => toJwk(k.kid, k.publicKeyPem)),
    }),
  } as unknown as ServiceKeyService;
  return new JwksService(fake);
}

describe('JwksService（契约 §1.5）', () => {
  const current = keyPair();
  const previous = keyPair();
  const product = keyPair();

  const asKey = (kid: string, pem: string, ownerCode = 'portal'): ServiceKey => ({
    ownerCode,
    kid,
    publicKeyPem: pem,
    notBefore: null,
    notAfter: null,
  });

  const service = serviceWith([
    asKey('portal-2026-10', current.publicKey),
    asKey('portal-2026-09', previous.publicKey),
  ]);

  it('toJwk 产出标准 RSA 公钥字段（kty/alg/use/kid/n/e）', () => {
    const jwk = toJwk('portal-2026-10', current.publicKey);
    expect(jwk).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: 'portal-2026-10' });
    expect(jwk.n).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(jwk.e).toBe('AQAB'); // 65537
  });

  it('JWKS 同时列出当前与轮换期历史公钥（否则轮换瞬间产品侧验签全挂）', () => {
    const { keys } = service.list();
    expect(keys.map((key) => key.kid)).toEqual(['portal-2026-10', 'portal-2026-09']);
  });

  it('JWKS 输出不含任何私钥字段', () => {
    const serialized = JSON.stringify(service.list());
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('d='); // RSA 私钥指数 d 绝不能出现
  });

  it('只输出 owner_code=portal 的公钥，产品公钥不得进 JWKS', () => {
    const mixed = serviceWith([
      asKey('portal-2026-10', current.publicKey),
      asKey('storage-2026-10', product.publicKey, 'storage'),
    ]);
    const kids = mixed.list().keys.map((key) => key.kid);
    expect(kids).toEqual(['portal-2026-10']);
    expect(kids).not.toContain('storage-2026-10');
  });

  it('未配置公钥时返回空 keys 而不是抛错（服务可正常启动）', () => {
    expect(serviceWith([]).list()).toEqual({ keys: [] });
  });

  it('kidFingerprint 用于排障比对，稳定且不泄露密钥', () => {
    const fingerprint = kidFingerprint(current.publicKey);
    expect(fingerprint).toHaveLength(16);
    expect(fingerprint).toBe(kidFingerprint(current.publicKey));
    expect(fingerprint).not.toBe(kidFingerprint(previous.publicKey));
  });
});
