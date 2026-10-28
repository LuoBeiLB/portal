import { createHash, createPublicKey } from 'node:crypto';

/** JWKS 里的一把公钥（标准结构） */
export interface JwkKey {
  kty: 'RSA';
  alg: 'RS256';
  use: 'sig';
  kid: string;
  n: string;
  e: string;
}

/**
 * PEM 公钥 → JWK（契约 §1.5 的 JWKS 结构）。
 *
 * 抽到 util 而不是留在 `jwks.service.ts`：`ServiceKeyService` 也要用它，
 * 留在 service 里会与 jwks.service 形成循环 import。
 */
export function toJwk(kid: string, pem: string): JwkKey {
  const publicKey = createPublicKey(pem);
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n?: string; e?: string };
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new Error(`kid=${kid} 的公钥不是 RSA 公钥，无法生成 JWKS`);
  }
  return { kty: 'RSA', alg: 'RS256', use: 'sig', kid, n: jwk.n, e: jwk.e };
}

/** 公钥指纹（前 16 位 hex）：用于比对"私钥派生出的公钥"与"库里的公钥"是否同一把 */
export function kidFingerprint(pem: string): string {
  return createHash('sha256').update(pem).digest('hex').slice(0, 16);
}