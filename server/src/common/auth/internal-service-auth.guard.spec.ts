import { Reflector } from '@nestjs/core';

import { ALLOW_PRODUCTS_KEY, ANY_PRODUCT } from './allow-products.decorator';
import { ExecutionContext } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { sign as jwtSign } from 'jsonwebtoken';

import { BizException, ErrorCode } from '../error/error-code';
import { INTERNAL_PRODUCT_KEY } from './internal-product.types';
import { InternalServiceAuthGuard, canonicalQuery } from './internal-service-auth.guard';
import { ServiceKey } from '../../modules/service-key/service-key.service';
import { ServiceKeyService } from '../../modules/service-key/service-key.service';

/**
 * 内网服务凭据守卫（`docs/27` §4.1）。
 *
 * 这组用例对应 `docs/27` §9.2 的十条攻击用例——**每条都必须被拒绝**。
 * 只测"正常能过"是不够的：这套改造的价值全在"攻击面被堵住"。
 */

const STORAGE_KID = 'storage-2026-10';

function keyPair(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const storage = keyPair();
const other = keyPair();

interface FakeRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, string>;
  rawBody?: Buffer;
  [INTERNAL_PRODUCT_KEY]?: { code: string; keyId: string };
}

interface Harness {
  guard: InternalServiceAuthGuard;
  redis: { set: jest.Mock };
  request: FakeRequest;
}

function harness(overrides: Partial<FakeRequest> = {}): Harness {
  const keyRow: ServiceKey = {
    ownerCode: 'storage',
    kid: STORAGE_KID,
    publicKeyPem: storage.publicKey,
    notBefore: null,
    notAfter: null,
  };
  const serviceKeys = {
    resolveProduct: jest.fn(async (kid: string): Promise<ServiceKey> => {
      /* 门户自己的公钥不允许用来调内网接口 */
      if (kid === 'portal-2026-10') {
        const portal = keyPair();
        return { ownerCode: 'portal', kid, publicKeyPem: portal.publicKey, notBefore: null, notAfter: null };
      }
      if (kid !== STORAGE_KID) throw new BizException(ErrorCode.UNAUTHENTICATED);
      return keyRow;
    }),
  } as unknown as ServiceKeyService;

  const redis = { set: jest.fn().mockResolvedValue('OK') };
  /*
   * 假 Reflector：默认返回 ANY_PRODUCT —— 这批用例测的是**验签/时效/请求绑定/重放**，
   * 接口级白名单另有独立用例（见文件末尾 describe）。
   */
  const allowAllReflector = {
    getAllAndOverride: jest.fn().mockReturnValue([ANY_PRODUCT]),
  } as unknown as Reflector;
  const guard = new InternalServiceAuthGuard(serviceKeys, redis as never, allowAllReflector);

  const request: FakeRequest = {
    method: 'POST',
    originalUrl: '/api/wallet/deduct',
    headers: {},
    rawBody: Buffer.from('{"amount_cents":3000}'),
    ...overrides,
  };
  return { guard, redis, request };
}

function ctxOf(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    /*
     * 真实的 ExecutionContext 一定有这两个方法（守卫要拿它们取 @AllowProducts 元数据）。
     * 这里给空实现即可 —— 本文件的 reflector 是假的，固定返回 ANY_PRODUCT。
     */
    getHandler: () => ({} as never),
    getClass: () => ({} as never),
  } as unknown as ExecutionContext;
}

/** 造一个合法服务凭据（可覆盖任意 claim 来模拟攻击） */
function credential(
  overrides: Record<string, unknown> = {},
  options: { kid?: string; privateKey?: string } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const request = harness().request;
  const payload = {
    iss: 'storage',
    aud: 'cloud-portal',
    htm: request.method,
    htu: request.originalUrl.replace(/^\/api(?=\/)/, ''),
    qs: canonicalQuery(request.originalUrl),
    body_sha256: 'PLACEHOLDER',
    iat: now,
    exp: now + 60,
    jti: 'jti-1',
    ...overrides,
  };
  return jwtSign(payload, options.privateKey ?? storage.privateKey, {
    algorithm: 'RS256',
    keyid: options.kid ?? STORAGE_KID,
  });
}

async function expectRejected(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BizException);
  expect((thrown as BizException).code).toBe(ErrorCode.UNAUTHENTICATED);
}

describe('InternalServiceAuthGuard（docs/27 §9.2 攻击用例）', () => {
  let bodyHash = '';

  beforeAll(async () => {
    const { createHash } = await import('node:crypto');
    bodyHash = createHash('sha256').update(Buffer.from('{"amount_cents":3000}')).digest('hex');
  });

  it('正常请求通过，并把产品身份挂到 request（code 来自 kid 归属，不信 body）', async () => {
    const h = harness();
    h.request.headers.authorization = `Bearer ${credential({ body_sha256: bodyHash })}`;

    await h.guard.canActivate(ctxOf(h.request));

    expect(h.request[INTERNAL_PRODUCT_KEY]).toEqual({ code: 'storage', keyId: STORAGE_KID });
    expect(h.redis.set).toHaveBeenCalledWith(
      'svc:jti:storage:jti-1',
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('#1 改 body（金额从 3000 改成 1）但签名不动 → 拒绝', async () => {
    const h = harness({ rawBody: Buffer.from('{"amount_cents":1}') });
    h.request.headers.authorization = `Bearer ${credential({ body_sha256: bodyHash })}`;
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('#2 用别家产品的密钥签名（kid 指向 storage，但私钥不是它的）→ 拒绝', async () => {
    const h = harness();
    h.request.headers.authorization = `Bearer ${credential(
      { body_sha256: bodyHash },
      { privateKey: other.privateKey },
    )}`;
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('#2b kid 不在 p_service_key 里 → 拒绝', async () => {
    const h = harness();
    h.request.headers.authorization = `Bearer ${credential({ body_sha256: bodyHash }, { kid: 'nope-1' })}`;
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('#3 拿用户 token（aud 不同）塞进内网接口 → 拒绝', async () => {
    const h = harness();
    const now = Math.floor(Date.now() / 1000);
    const userToken = jwtSign(
      { sub: 'u-1', uname: 'luobo', role: 'user', ut: 0, iat: now, exp: now + 7200 },
      storage.privateKey,
      { algorithm: 'RS256', keyid: STORAGE_KID },
    );
    h.request.headers.authorization = `Bearer ${userToken}`;
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('#4 同一凭据重放第二次 → 拒绝（Redis 返回已存在）', async () => {
    const h = harness();
    h.redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const token = credential({ body_sha256: bodyHash });

    h.request.headers.authorization = `Bearer ${token}`;
    await h.guard.canActivate(ctxOf(h.request));

    const h2 = harness();
    h2.redis.set.mockResolvedValue(null);
    h2.request.headers.authorization = `Bearer ${token}`;
    await expectRejected(() => h2.guard.canActivate(ctxOf(h2.request)));
  });

  it('#5 token 已过期 → 拒绝', async () => {
    const h = harness();
    const past = Math.floor(Date.now() / 1000) - 600;
    h.request.headers.authorization = `Bearer ${credential({ body_sha256: bodyHash, iat: past, exp: past + 60 })}`;
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('#6 拿"查成员"的凭据去调 deduct（htu 不符）→ 拒绝', async () => {
    const h = harness();
    h.request.headers.authorization = `Bearer ${credential({
      body_sha256: bodyHash,
      htu: '/internal/enterprise-accounts',
    })}`;
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('#7 把 query 里的 enterprise_id 改掉（qs 不符）→ 拒绝', async () => {
    const h = harness({ method: 'GET', originalUrl: '/api/internal/enterprise-accounts?enterprise_id=3' });
    h.request.headers.authorization = `Bearer ${credential({
      htm: 'GET',
      htu: '/internal/enterprise-accounts',
      qs: 'enterprise_id=4',
      body_sha256: undefined,
    })}`;
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('#8 alg=none 的 token → 拒绝', async () => {
    const h = harness();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'storage', aud: 'cloud-portal' })).toString('base64url');
    h.request.headers.authorization = `Bearer ${header}.${payload}.`;
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('#9 alg=HS256 + 拿公钥当 HMAC 密钥 → 拒绝（算法白名单）', async () => {
    const h = harness();
    const now = Math.floor(Date.now() / 1000);
    const forged = jwtSign(
      { iss: 'storage', aud: 'cloud-portal', htm: 'POST', htu: '/wallet/deduct', iat: now, exp: now + 60, jti: 'x' },
      storage.publicKey, // ← 攻击者只知道公钥
      { algorithm: 'HS256', keyid: STORAGE_KID },
    );
    h.request.headers.authorization = `Bearer ${forged}`;
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('Redis 不可用 → fail-closed（放行等于防重放静默失效）', async () => {
    const h = harness();
    h.redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    h.request.headers.authorization = `Bearer ${credential({ body_sha256: bodyHash })}`;
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('缺少 Authorization 头 → 拒绝', async () => {
    const h = harness();
    await expectRejected(() => h.guard.canActivate(ctxOf(h.request)));
  });

  it('canonicalQuery 按 key 字典序 + encodeURIComponent', () => {
    expect(canonicalQuery('/x?a=1&b=2')).toBe('a=1&b=2');
    expect(canonicalQuery('/x?b=2&a=1')).toBe('a=1&b=2');
    expect(canonicalQuery('/x?kw=%E4%B8%AD%E6%96%87')).toBe('kw=%E4%B8%AD%E6%96%87');
    expect(canonicalQuery('/x')).toBe('');
  });
});
