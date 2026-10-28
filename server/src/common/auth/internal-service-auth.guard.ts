import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { decode, verify as jwtVerify } from 'jsonwebtoken';

import { REDIS_CLIENT } from '../redis/redis.constants';

import { BizException, ErrorCode } from '../error/error-code';
import { ServiceKeyService } from '../../modules/service-key/service-key.service';
import { INTERNAL_PRODUCT_KEY, InternalProduct } from './internal-product.types';

/** 服务凭据的时钟容忍（秒）：允许对方时钟比门户快/慢这么多 */
const CLOCK_SKEW_SECONDS = 120;
/** nonce（jti）保留时长：必须 >= exp 窗口 + 时钟容忍，否则 jti 先过期就出现重放窗口 */
const NONCE_TTL_SECONDS = 240;

/** 入站服务凭据的 claim 形状（`docs/27` §3.1） */
interface ServiceCredentialPayload {
  iss: string;
  aud: string;
  htm: string;
  htu: string;
  qs?: string;
  body_sha256?: string;
  iat: number;
  exp: number;
  jti: string;
}

/**
 * 内网接口鉴权：**RS256 服务凭据**（`docs/27` §4.1）。
 *
 * 取代原来的 `InternalKeyGuard`（`X-Internal-Key` 静态共享密钥）。
 * 差异不只是"换个头"：
 *
 * | 能力 | X-Internal-Key | 本守卫 |
 * |---|---|---|
 * | 密钥是否上网 | 明文发 | 只发签名 |
 * | 伪造门槛 | 拿到密钥即可 | 需要对方私钥 |
 * | 有效期 | 永久 | 60 秒 |
 * | 防重放 | 无 | `jti` 去重 |
 * | 防篡改 | 无 | `body_sha256` / `qs` / `htu` |
 * | 跨场景混用 | 无防护 | `aud` + `htm` / `htu` |
 *
 * ## 校验顺序为什么是这样
 *
 * 1. 先验签（最便宜且能挡住绝大多数无效请求）
 * 2. 再校验请求绑定（htm/htu/qs/body）—— 防止"合法 token 用在别的请求上"
 * 3. **最后写 nonce**。若先写 nonce 再验签，攻击者可以用无效签名灌满 Redis；
 *    现在这个顺序下，无效请求根本走不到写 nonce 那一步。
 *
 * ## 错误一律 1002
 *
 * 不回显具体原因（签名错/过期/重放），否则等于给攻击者一个探测信号。
 */
@Injectable()
export class InternalServiceAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalServiceAuthGuard.name);

  constructor(
    private readonly serviceKeys: ServiceKeyService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & Record<string, unknown>>();
    const token = extractBearer(request);
    if (!token) throw new BizException(ErrorCode.UNAUTHENTICATED);

    /* 只从 header 里读 kid，**不信任 token 内容**；公钥由 kid 反查 */
    const decoded = decode(token, { complete: true }) as
      | { header?: { alg?: string; kid?: string } }
      | null;
    const alg = decoded?.header?.alg;
    const kid = decoded?.header?.kid;
    if (alg !== 'RS256' || !kid) {
      // 不收 none / HS256：这是 JWT 最经典的 alg 混淆攻击面
      throw new BizException(ErrorCode.UNAUTHENTICATED);
    }

    const key = await this.serviceKeys.resolveProduct(kid);

    let payload: ServiceCredentialPayload;
    try {
      /*
       * 用 jsonwebtoken 直接验，**不用 JwtService**：
       * JwtService 只认模块里配的那把密钥（门户自己的），而这里必须用**该产品自己的公钥**。
       * 用错密钥的后果是"任何产品都验不过"，或者更糟——放过了不该放过的签名。
       *
       * `algorithms: ['RS256']` 是硬要求：不锁死算法就会被 alg=none / alg=HS256
       * （拿公钥当 HMAC 密钥）伪造。
       */
      payload = jwtVerify(token, key.publicKeyPem, {
        algorithms: ['RS256'],
        issuer: key.ownerCode,
        audience: 'cloud-portal',
      }) as ServiceCredentialPayload;
    } catch (error) {
      this.logger.warn(`服务凭据验签失败 kid=${kid}：${(error as Error).message}`);
      throw new BizException(ErrorCode.UNAUTHENTICATED);
    }

    assertFresh(payload);
    assertRequestBinding(payload, request);
    assertBodyHash(payload, request);

    await this.assertNotReplayed(payload);

    request[INTERNAL_PRODUCT_KEY] = {
      code: key.ownerCode,
      keyId: key.kid,
    } satisfies InternalProduct;
    return true;
  }

  /**
   * `jti` 去重。**Redis 不可用时必须 fail-closed** ——
   * 放行等于防重放静默失效（注意 `RateLimiterService` 是 fail-open，不能照抄那边）。
   */
  private async assertNotReplayed(payload: ServiceCredentialPayload): Promise<void> {
    if (!payload.jti) throw new BizException(ErrorCode.UNAUTHENTICATED);

    const redisKey = `svc:jti:${payload.iss}:${payload.jti}`;
    let stored: string | null;
    try {
      // SET NX EX 是原子的；用 GET 再 SET 会有并发窗口，两次重放能同时通过
      stored = await this.redis.set(redisKey, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
    } catch (error) {
      // ⚠️ fail-closed：Redis 不可用时无法判断是否重放，只能拒绝
      this.logger.error(`jti 去重不可用（Redis 异常），已拒绝请求：${(error as Error).message}`);
      throw new BizException(ErrorCode.UNAUTHENTICATED);
    }
    if (stored !== 'OK') {
      this.logger.warn(`检测到重放 jti=${payload.jti} iss=${payload.iss}`);
      throw new BizException(ErrorCode.UNAUTHENTICATED);
    }
  }
}

/* ────────────────────────── 纯函数 ────────────────────────── */

function extractBearer(request: Request): string | null {
  const header = request.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || null;
}

/** 时间窗口：`iat` 不能太旧，`exp` 不能过 */
function assertFresh(payload: ServiceCredentialPayload): void {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now >= payload.exp) {
    throw new BizException(ErrorCode.UNAUTHENTICATED);
  }
  if (typeof payload.iat !== 'number' || Math.abs(now - payload.iat) > CLOCK_SKEW_SECONDS) {
    throw new BizException(ErrorCode.UNAUTHENTICATED);
  }
}

/** 请求绑定：token 只能用于签发时声明的那一个方法 + 路径 + query */
function assertRequestBinding(payload: ServiceCredentialPayload, request: Request): void {
  const method = (request.method || '').toUpperCase();
  if (payload.htm !== method) throw new BizException(ErrorCode.UNAUTHENTICATED);

  /* htu 不含 /api 前缀：全局前缀由 main.ts 剥掉，这里用 originalUrl 手工去掉 */
  const path = (request.originalUrl || request.url || '').split('?')[0] ?? '';
  const withoutPrefix = path.replace(/^\/api(?=\/)/, '');
  if (payload.htu !== withoutPrefix) throw new BizException(ErrorCode.UNAUTHENTICATED);

  const expectedQs = canonicalQuery(request.originalUrl || request.url || '');
  if ((payload.qs ?? '') !== expectedQs) throw new BizException(ErrorCode.UNAUTHENTICATED);
}

/** body 完整性：必须对**原始字节**算 hash（不能反序列化再序列化） */
function assertBodyHash(payload: ServiceCredentialPayload, request: Request): void {
  const raw = (request as unknown as { rawBody?: Buffer }).rawBody;
  const hasBody = Boolean(raw && raw.length > 0);
  if (!hasBody) {
    /* 无 body 时要求 claim 也是空（或未带），防止"拿带 hash 的 token 打空 body 的接口" */
    if (payload.body_sha256) throw new BizException(ErrorCode.UNAUTHENTICATED);
    return;
  }
  if (!payload.body_sha256) throw new BizException(ErrorCode.UNAUTHENTICATED);
  const actual = createHash('sha256').update(raw as Buffer).digest('hex');
  if (actual !== payload.body_sha256) throw new BizException(ErrorCode.UNAUTHENTICATED);
}

/**
 * query 规范化（`docs/27` §3.3）：按 key 字典序、`encodeURIComponent`、`&` 连接。
 * 无 query 返回空串。
 */
export function canonicalQuery(url: string): string {
  const index = url.indexOf('?');
  if (index < 0) return '';
  const params = new URLSearchParams(url.slice(index + 1));
  const entries = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export { CLOCK_SKEW_SECONDS, NONCE_TTL_SECONDS };