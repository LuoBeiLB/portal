import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

import { INTERNAL_PRODUCT_KEY, InternalProduct } from './internal-product.types';

/**
 * 取出由 `InternalKeyGuard` 解析出的调用方产品身份。
 *
 * 用法：`@UseGuards(InternalKeyGuard) ... method(@InternalProduct() product: InternalProduct)`
 *
 * ⚠️ 内网接口里**只允许**用这个身份，不要用请求体里的 `product_code` ——
 * 后者是调用方自报的，未经验证。
 */
export const CurrentInternalProduct = createParamDecorator(
  (_data: unknown, context: ExecutionContext): InternalProduct => {
    const request = context.switchToHttp().getRequest<Request & Record<string, unknown>>();
    const product = request[INTERNAL_PRODUCT_KEY] as InternalProduct | undefined;
    if (!product) {
      // 走到这里说明路由忘了挂 InternalKeyGuard —— 宁可报错也不要放行
      throw new Error('CurrentInternalProduct 必须在 InternalKeyGuard 之后使用');
    }
    return product;
  },
);
