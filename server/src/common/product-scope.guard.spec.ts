import { ExecutionContext } from '@nestjs/common';

import { BizException, ErrorCode } from './error-code';
import { INTERNAL_PRODUCT_KEY, InternalProduct } from './internal-product.types';
import { ProductScopeGuard } from './product-scope.guard';

interface FakeRequest {
  body?: Record<string, unknown>;
  [INTERNAL_PRODUCT_KEY]?: InternalProduct;
}

function contextOf(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as ExecutionContext;
}

const guard = new ProductScopeGuard();
const asStorage: InternalProduct = { code: 'storage', key: 'key-storage' };

describe('ProductScopeGuard（body 自报的 product_code 必须与密钥归属一致）', () => {
  it('未自报 product_code → 放行（身份以密钥为准）', () => {
    expect(guard.canActivate(contextOf({ body: {}, [INTERNAL_PRODUCT_KEY]: asStorage }))).toBe(true);
  });

  it('body 为空 → 放行', () => {
    expect(guard.canActivate(contextOf({ [INTERNAL_PRODUCT_KEY]: asStorage }))).toBe(true);
  });

  it('空字符串视为未自报 → 放行', () => {
    expect(guard.canActivate(contextOf({ body: { product_code: '' }, [INTERNAL_PRODUCT_KEY]: asStorage }))).toBe(true);
  });

  it('自报与密钥归属一致 → 放行', () => {
    expect(guard.canActivate(contextOf({ body: { product_code: 'storage' }, [INTERNAL_PRODUCT_KEY]: asStorage }))).toBe(
      true,
    );
  });

  it('**自报成别人的产品 → 1004**（本轮修复的核心场景）', () => {
    try {
      guard.canActivate(contextOf({ body: { product_code: 'phone' }, [INTERNAL_PRODUCT_KEY]: asStorage }));
      throw new Error('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).code).toBe(ErrorCode.FORBIDDEN);
      expect((error as BizException).message).toContain('storage');
    }
  });

  it('自报成不存在的产品 → 1004', () => {
    try {
      guard.canActivate(contextOf({ body: { product_code: 'not-a-product' }, [INTERNAL_PRODUCT_KEY]: asStorage }));
      throw new Error('应当抛出');
    } catch (error) {
      expect((error as BizException).code).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it('自报成非字符串（如数字/对象）→ 1004，不做隐式转换', () => {
    for (const value of [1, true, { code: 'storage' }, ['storage']]) {
      expect(() =>
        guard.canActivate(contextOf({ body: { product_code: value }, [INTERNAL_PRODUCT_KEY]: asStorage })),
      ).toThrow(BizException);
    }
  });

  it('没挂 InternalKeyGuard（身份缺失）→ 直接报错，而不是静默放行', () => {
    expect(() => guard.canActivate(contextOf({ body: { product_code: 'storage' } }))).toThrow(/InternalKeyGuard/);
  });
});
