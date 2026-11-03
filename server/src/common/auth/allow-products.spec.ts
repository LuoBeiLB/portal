import { ANY_PRODUCT, resolveEndpointAllowance } from './allow-products.decorator';

/**
 * 接口级产品白名单（内网接口的第二道闸）。
 *
 * 背景：`InternalServiceAuthGuard` 只验证"是不是某个已登记的产品"。
 * 改造成 RS256 后，**任一产品的凭据都能调全部内网接口** —— 而 X-Internal-Key 时代
 * 每个产品一把独立密钥，其实也是同样的宽松。这里把"谁能调哪个接口"显式化。
 *
 * 判定规则（fail-closed）：
 * 1. 接口没声明 `@AllowProducts` → **拒绝**（新增接口忘了声明会立刻暴露）
 * 2. 声明了 `ANY_PRODUCT` → 放行
 * 3. 否则必须命中列表
 */
describe('resolveEndpointAllowance（内网接口的产品白名单）', () => {
  it('未声明（元数据不存在）→ 拒绝，提示要加 @AllowProducts', () => {
    expect(resolveEndpointAllowance(undefined, 'storage')).toMatch(/未声明/);
    expect(resolveEndpointAllowance(null, 'phone')).toMatch(/未声明/);
  });

  it('空列表 = 显式停用 → 拒绝，但文案指向替代接口（不是"忘声明"）', () => {
    const reason = resolveEndpointAllowance([], 'storage');
    expect(reason).toMatch(/已停用/);
    expect(reason).toMatch(/internal\/orders/);
    /* 关键：不能和"未声明"混为一谈 —— 一个该改代码，一个该换接口 */
    expect(reason).not.toMatch(/未声明/);
  });

  it('ANY_PRODUCT → 放行任何产品', () => {
    for (const code of ['storage', 'phone', 'desktop', '未知产品']) {
      expect(resolveEndpointAllowance([ANY_PRODUCT], code)).toBeNull();
    }
  });

  it('命中白名单 → 放行', () => {
    expect(resolveEndpointAllowance(['storage', 'phone'], 'phone')).toBeNull();
  });

  it('未命中 → 拒绝，且文案列出允许的产品（便于对方自查配置）', () => {
    const reason = resolveEndpointAllowance(['storage'], 'phone');
    expect(reason).toMatch(/产品 phone 无权调用该接口/);
    expect(reason).toMatch(/storage/);
  });

  it('白名单区分大小写（产品 code 来自 kid 归属，不做容错转换）', () => {
    expect(resolveEndpointAllowance(['storage'], 'Storage')).toMatch(/无权调用/);
  });
});
