import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';

import { PortalConfigService } from '../../config/portal-config.service';
import { bodySha256, canonicalQuery, stripApiPrefix } from '../../common/util/canonical.util';

/** 服务凭据的有效期：60 秒。够一次内网调用，泄漏窗口极小 */
export const SERVICE_TOKEN_TTL_SECONDS = 60;

/** 出站请求的形状：用于生成**请求绑定** claim */
export interface ServiceRequestBinding {
  /** HTTP 方法，大写 */
  method: string;
  /** 含 /api 前缀的实际路径（内部会剥掉） */
  path: string;
  /** 裸 query 串（不带 ?），没有就不传 */
  query?: string;
  /** **实际发送出去的那份 body 文本**（不是对象），用于算 body_sha256 */
  bodyText?: string;
}

/** 额外业务声明（如 order_item_id），便于产品侧与请求体对账 */
export interface ServiceTokenInput {
  [key: string]: unknown;
}

/**
 * 签发出站服务凭据（门户 → 产品）。对应 `docs/27` §3.2。
 *
 * ## 为什么必须带请求绑定 claim
 *
 * 只带身份（iss/aud）的凭据可以被"搬到另一个请求上"用：
 * 拿到一个合法的"查商品目录"凭据，就能去调"开通"。
 *
 * 所以凭据里必须写明 `htm` / `htu` / `qs` / `body_sha256`，
 * 收方逐字比对实际请求——这是**产品侧（云手机）已经实现的校验**，
 * 门户这边起初漏签，会导致对方 1002「凭据与请求不匹配」。
 *
 * ## 为什么用同一个门户私钥
 *
 * 产品本来就要验门户签的**用户 token**（JWKS 公钥已在手），
 * 用同一把私钥签服务凭据，产品侧无需新增任何密钥配置，只是多校验 `aud`。
 *
 * ## 为什么每次都要新 `jti`
 *
 * TTL 只有 60 秒，但**不能缓存复用**——`jti` 相同会被收方判成重放。
 * RSA-2048 签名约 1ms，每请求签一次可以接受。
 */
@Injectable()
export class ServiceTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: PortalConfigService,
  ) {}

  async issue(
    productCode: string,
    binding: ServiceRequestBinding,
    extra: ServiceTokenInput = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const bodyHash = bodySha256(binding.bodyText);

    return this.jwt.signAsync(
      {
        /*
         * ⚠️ 这里**不要**写 `iss`：`TokenModule` 的全局 `signOptions.issuer` 已经带了，
         * payload 再写一份会被 jsonwebtoken 判成
         * `Bad "options.issuer" option. The payload already has an "iss" property` 而签名失败。
         */
        aud: productCode,
        htm: binding.method.toUpperCase(),
        htu: stripApiPrefix(binding.path),
        qs: canonicalQuery(binding.query ?? ''),
        ...(bodyHash ? { body_sha256: bodyHash } : {}),
        ...extra,
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
