import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';

import { PortalConfigService } from '../../config/portal-config.service';

/** 服务凭据的有效期：60 秒。够一次内网调用，泄漏窗口极小 */
export const SERVICE_TOKEN_TTL_SECONDS = 60;

/** 出站服务凭据里除标准 claim 外的业务字段 */
export interface ServiceTokenInput {
  order_item_id?: string;
  portal_user_id?: string;
  sku_id?: string;
  quantity?: number;
  period_hours?: number | null;
  period_days?: number;
  [key: string]: unknown;
}

/**
 * 签发出站服务凭据（门户 → 产品）。对应 `docs/27` §3.2。
 *
 * ## 为什么用同一个门户私钥
 *
 * 产品本来就要验门户签的**用户 token**（JWKS 公钥已在手），
 * 用同一把私钥签服务凭据，产品侧**无需新增任何密钥配置**，只是多校验一个 `aud`。
 *
 * ## 为什么每次都要新 `jti`
 *
 * 服务凭据 TTL 只有 60 秒，但**不能缓存复用**——`jti` 相同会被收方判成重放。
 * RSA 签名约 1ms，每个请求签一次可以接受。
 */
@Injectable()
export class ServiceTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: PortalConfigService,
  ) {}

  async issue(productCode: string, input: ServiceTokenInput = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return this.jwt.signAsync(
      {
        /*
         * ⚠️ 这里**不要**再写 `iss`：`TokenModule` 的全局 `signOptions.issuer` 已经带了，
         * payload 再写一份会被 jsonwebtoken 判成
         * `Bad "options.issuer" option. The payload already has an "iss" property` 而签名失败。
         * 最终签出来的 token 里 `iss` 仍然是 `config.jwt.issuer`（cloud-portal）。
         */
        aud: productCode,
        ...input,
        iat: now,
        exp: now + SERVICE_TOKEN_TTL_SECONDS,
        jti: randomBytes(16).toString('hex'),
      },
      { algorithm: 'RS256', keyid: this.config.jwt.current.kid },
    );
  }

  /** 便于日志/排障：只给 kid 与 aud，不泄露 token 本体 */
  describe(productCode: string): string {
    return `服务凭据 aud=${productCode} kid=${this.config.jwt.current.kid} ttl=${SERVICE_TOKEN_TTL_SECONDS}s`;
  }
}