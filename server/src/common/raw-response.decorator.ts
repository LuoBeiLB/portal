import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'portal:rawResponse';

/**
 * 标记「不走统一响应包装」的接口。
 *
 * 统一响应 `{code,message,data}`（契约 §0.2）适用于业务接口，
 * 但有两类例外必须原样输出，否则客户端无法消费：
 * - 契约 §1.5 的 JWKS：产品侧按标准 JWKS 结构解析（`{keys:[...]}`），不能套壳；
 * - 契约 §6 的 CSV 导出：Content-Type 是 text/csv，套壳会变成 JSON。
 */
export const RawResponse = (): MethodDecorator & ClassDecorator => SetMetadata(RAW_RESPONSE_KEY, true);
