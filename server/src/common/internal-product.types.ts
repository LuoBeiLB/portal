import { SetMetadata } from '@nestjs/common';

/** 由 InternalKeyGuard 解析出的调用方产品身份 */
export interface InternalProduct {
  /** storage / phone / desktop —— 来自密钥归属，**不是**请求体自报 */
  code: string;
  /** 命中的密钥本身，仅用于日志/审计，不要外传 */
  key: string;
}

/** 挂在 request 上的字段名（避免与其它中间件冲突） */
export const INTERNAL_PRODUCT_KEY = 'internalProduct';
