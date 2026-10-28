import { SetMetadata } from '@nestjs/common';

/**
 * 由 `InternalServiceAuthGuard` 解析出的调用方身份（`docs/27`）。
 *
 * 身份来源是 `p_service_key` 表：`kid` → `owner_code`。
 * **不是**请求体自报的 `product_code`（那是未经验证的声明，由 `ProductScopeGuard` 拦）。
 */
export interface InternalProduct {
  /** storage / phone / desktop —— 来自公钥归属 */
  code: string;
  /** 命中的 kid，用于日志与审计；不含任何密钥material */
  keyId: string;
}

/** 挂在 request 上的字段名（避免与其它中间件冲突） */
export const INTERNAL_PRODUCT_KEY = 'internalProduct';