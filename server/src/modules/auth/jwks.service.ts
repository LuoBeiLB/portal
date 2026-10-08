import { Injectable } from '@nestjs/common';
import { createHash, createPublicKey } from 'node:crypto';

import { PortalConfigService } from '../../config/portal-config.service';

export interface JwkKey {
  kty: 'RSA';
  alg: 'RS256';
  use: 'sig';
  kid: string;
  n: string;
  e: string;
}

/**
 * JWKS 输出（契约 §1.5）。
 * 契约要求产品侧「启动时拉取 + 每 12h 刷新 + kid 不匹配时立即强制刷新」，
 * 因此这里必须把**当前公钥与轮换期历史公钥都列出来**，否则轮换瞬间产品侧验签全挂。
 */
@Injectable()
export class JwksService {
  constructor(private readonly config: PortalConfigService) {}

  list(): { keys: JwkKey[] } {
    const keys: JwkKey[] = [];

    const current = this.config.jwt.current;
    if (current.publicKey) {
      keys.push(toJwk(current.kid, current.publicKey));
    }
    for (const previous of this.config.jwt.previous) {
      keys.push(toJwk(previous.kid, previous.publicKey));
    }
    return { keys };
  }
}

export function toJwk(kid: string, pem: string): JwkKey {
  const publicKey = createPublicKey(pem);
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n?: string; e?: string };
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new Error(`kid=${kid} 的公钥不是 RSA 公钥，无法生成 JWKS`);
  }
  return { kty: 'RSA', alg: 'RS256', use: 'sig', kid, n: jwk.n, e: jwk.e };
}

/** 便于排障：输出公钥指纹（kid 之外的一致性校验），不泄露密钥本体 */
export function kidFingerprint(pem: string): string {
  return createHash('sha256').update(pem).digest('hex').slice(0, 16);
}
