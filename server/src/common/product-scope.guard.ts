import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { BizException, ErrorCode } from './error-code';
import { INTERNAL_PRODUCT_KEY, InternalProduct } from './internal-product.types';

/**
 * 产品身份范围校验 —— 必须挂在 `InternalKeyGuard` **之后**。
 *
 * 规则：如果请求体里自报了 `product_code`，它必须与密钥归属的产品一致，否则 1004。
 *
 * 为什么允许"不传"：契约 §4.1 把 `product_code` 定为必填，但实际接入方（云存储）
 * 的扣费请求体里并没有它。与其要求各家改代码，不如让"密钥即身份"成为事实：
 * 不传 → 按密钥推定；传了 → 必须对，传错立刻报错（这能抓出真实 bug）。
 *
 * 用法：`@UseGuards(InternalKeyGuard, ProductScopeGuard)`
 */
@Injectable()
export class ProductScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & Record<string, unknown>>();
    const product = request[INTERNAL_PRODUCT_KEY] as InternalProduct | undefined;
    if (!product) {
      // 顺序挂错（ProductScopeGuard 在 InternalKeyGuard 之前）会走到这里
      throw new Error('ProductScopeGuard 必须挂在 InternalKeyGuard 之后');
    }

    const body = request.body as { product_code?: unknown } | undefined;
    const claimed = body?.product_code;

    // 未自报 → 放行（身份以密钥为准）
    if (claimed === undefined || claimed === null || claimed === '') return true;

    if (typeof claimed !== 'string' || claimed !== product.code) {
      throw new BizException(
        ErrorCode.FORBIDDEN,
        `密钥属于 ${product.code}，与请求声明的 product_code（${String(claimed)}）不一致`,
      );
    }

    return true;
  }
}
