import { ExecutionContext } from '@nestjs/common';

import { PortalConfigService } from '../config/portal-config.service';
import { BizException, ErrorCode } from './error-code';
import { InternalKeyGuard } from './internal-key.guard';
import { INTERNAL_PRODUCT_KEY, InternalProduct } from './internal-product.types';

interface FakeRequest {
  headers: Record<string, string>;
  [INTERNAL_PRODUCT_KEY]?: InternalProduct;
}

function contextOf(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as ExecutionContext;
}

/** 按 (code, key) 列表构造配置；地址非空即代表已接入 */
function guardOf(products: Array<{ code: string; internalKey: string }>): InternalKeyGuard {
  const config = {
    products: products.map((item) => ({
      code: item.code,
      baseUrl: `http://127.0.0.1:9000/${item.code}`,
      internalKey: item.internalKey,
      enabled: true,
    })),
  } as unknown as PortalConfigService;
  return new InternalKeyGuard(config);
}

describe('InternalKeyGuard（密钥 → 产品身份绑定）', () => {
  const products = [
    { code: 'storage', internalKey: 'key-storage' },
    { code: 'phone', internalKey: 'key-phone' },
  ];

  it('缺少 X-Internal-Key → 1002', () => {
    const guard = guardOf(products);
    expect(() => guard.canActivate(contextOf({ headers: {} }))).toThrow(BizException);
    try {
      guard.canActivate(contextOf({ headers: {} }));
    } catch (error) {
      expect((error as BizException).code).toBe(ErrorCode.UNAUTHENTICATED);
    }
  });

  it('密钥不匹配任何产品 → 1002', () => {
    const guard = guardOf(products);
    try {
      guard.canActivate(contextOf({ headers: { 'x-internal-key': 'wrong' } }));
      throw new Error('应当抛出');
    } catch (error) {
      expect((error as BizException).code).toBe(ErrorCode.UNAUTHENTICATED);
    }
  });

  it('命中唯一产品：放行，并把**该产品身份**挂到 request 上', () => {
    const guard = guardOf(products);
    const request: FakeRequest = { headers: { 'x-internal-key': 'key-phone' } };
    expect(guard.canActivate(contextOf(request))).toBe(true);
    expect(request[INTERNAL_PRODUCT_KEY]?.code).toBe('phone');
  });

  it('同一把密钥配给多个产品 → fail-closed 拒绝（身份不可判定）', () => {
    const guard = guardOf([
      { code: 'storage', internalKey: 'same-key' },
      { code: 'phone', internalKey: 'same-key' },
    ]);
    const request: FakeRequest = { headers: { 'x-internal-key': 'same-key' } };
    try {
      guard.canActivate(contextOf(request));
      throw new Error('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).code).toBe(ErrorCode.UNAUTHENTICATED);
    }
    // 关键：拒绝时不能留下身份痕迹，否则后续 Guard 会以为认证通过
    expect(request[INTERNAL_PRODUCT_KEY]).toBeUndefined();
  });

  it('未配置密钥的产品（internalKey 为空）不参与匹配', () => {
    const guard = guardOf([
      { code: 'storage', internalKey: 'key-storage' },
      { code: 'phone', internalKey: '' },
    ]);
    try {
      // 空字符串不得被当作"有效密钥"而放行任意请求
      guard.canActivate(contextOf({ headers: { 'x-internal-key': '' } }));
      throw new Error('应当抛出');
    } catch (error) {
      expect((error as BizException).code).toBe(ErrorCode.UNAUTHENTICATED);
    }
  });

  it('数组形态的请求头取第一个值', () => {
    const guard = guardOf(products);
    const request: FakeRequest = { headers: {} };
    (request.headers as Record<string, unknown>)['x-internal-key'] = ['key-storage', 'key-phone'];
    expect(guard.canActivate(contextOf(request))).toBe(true);
    expect(request[INTERNAL_PRODUCT_KEY]?.code).toBe('storage');
  });
});
