import { SetMetadata } from '@nestjs/common';

/** 元数据键：该内网接口允许哪些产品 code 调用 */
export const ALLOW_PRODUCTS_KEY = 'allowProducts';

/** 通配：允许**任何已登记**的产品凭据调用（等于"不额外限制"） */
export const ANY_PRODUCT = '*';

/**
 * 声明本接口允许哪些产品调用（内网接口的第二道闸）。
 *
 * ## 为什么需要它
 *
 * `InternalServiceAuthGuard` 只回答"**是不是**某个已登记的产品"，
 * 不回答"**这个**产品能不能调**这个**接口"。X-Internal-Key 时代每个产品一把独立密钥，
 * 但**任一产品的密钥都能调全部内网接口** —— 那是不做最小权限，不是设计。
 *
 * 加了这层之后：
 * - **每个内网接口必须显式声明**谁能调（`@AllowProducts('storage')` 或 `@AllowProducts(ANY_PRODUCT)`）
 * - **没声明 = 一律拒绝**（fail-closed）。新加接口忘了声明会被立刻发现，
 *   而不是悄悄对三个产品全放开
 *
 * ## 它不解决什么
 *
 * 它只管"哪个产品"，不管"哪个用户/企业"。产品 A 拿到合法凭据后，仍然可以查任何企业的成员
 * （那是业务语义决定的：产品要服务多企业）。要按数据维度隔离，需要另一层（如租户归属校验）。
 */
export const AllowProducts = (...codes: string[]) => SetMetadata(ALLOW_PRODUCTS_KEY, codes);

/**
 * 接口级白名单的判定逻辑（**纯函数**，便于单测）。
 *
 * 返回 `null` 表示放行；返回字符串表示拒绝原因（直接作为 1004 的 message）。
 */
export function resolveEndpointAllowance(
  allowed: string[] | undefined | null,
  ownerCode: string,
): string | null {
  if (!allowed || allowed.length === 0) {
    return '该内网接口未声明可调用的产品（@AllowProducts），服务凭据一律拒绝';
  }
  if (allowed.includes(ANY_PRODUCT)) return null;
  if (!allowed.includes(ownerCode)) {
    return `产品 ${ownerCode} 无权调用该接口（允许：${allowed.join('/')}）`;
  }
  return null;
}
