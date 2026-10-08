import { generateKeyPairSync } from 'node:crypto';

import { PortalConfigService } from '../../config/portal-config.service';
import { JwksService, kidFingerprint, toJwk } from './jwks.service';

function keyPair(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

describe('JwksService（契约 §1.5）', () => {
  const current = keyPair();
  const previous = keyPair();

  const service = new JwksService({
    jwt: {
      current: { kid: 'portal-2026-10', privateKey: current.privateKey, publicKey: current.publicKey },
      previous: [{ kid: 'portal-2026-09', publicKey: previous.publicKey }],
    },
  } as unknown as PortalConfigService);

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

  it('未配置公钥时返回空 keys 而不是抛错（服务可正常启动）', () => {
    const empty = new JwksService({
      jwt: { current: { kid: 'k', privateKey: '', publicKey: '' }, previous: [] },
    } as unknown as PortalConfigService);
    expect(empty.list()).toEqual({ keys: [] });
  });

  it('kidFingerprint 用于排障比对，稳定且不泄露密钥', () => {
    const fingerprint = kidFingerprint(current.publicKey);
    expect(fingerprint).toHaveLength(16);
    expect(fingerprint).toBe(kidFingerprint(current.publicKey));
    expect(fingerprint).not.toBe(kidFingerprint(previous.publicKey));
  });
});
