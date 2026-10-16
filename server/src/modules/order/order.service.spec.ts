import { generateOrderNo } from './order.service';

/**
 * 订单号格式。
 *
 * 重点盯住中间那两条：**取值范围与补零宽度必须同源**。
 * 这里曾经出过事故 —— 范围从 10^6 调到 10^9，但 `padStart` 还是 6，
 * 于是九成的订单号是 9 位、偶尔冒出 7~8 位的不定长号。
 * 用 `Math.random` 的两个端点值把这个不变量钉住。
 */
describe('generateOrderNo（订单号格式）', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const at = (iso: string) => new Date(iso);

  it('格式为 O + 8 位 UTC 日期 + 9 位随机', () => {
    const no = generateOrderNo(at('2026-10-15T03:04:05Z'));
    expect(no).toMatch(/^O\d{8}-\d{9}$/);
    expect(no.startsWith('O20261015-')).toBe(true);
  });

  it('随机数为 0 时补零到 9 位（宽度不得小于范围位数）', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(generateOrderNo(at('2026-10-15T00:00:00Z'))).toBe('O20261015-000000000');
  });

  it('随机数接近 1 时取到最大值 999999999，且仍为 9 位（不得越界到 10 位）', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.9999999999);
    const no = generateOrderNo(at('2026-10-15T00:00:00Z'));
    expect(no).toBe('O20261015-999999999');
    expect(no).toMatch(/^O\d{8}-\d{9}$/);
  });

  it('日期部分按 UTC 取（本地时间跨日不影响）', () => {
    // UTC 2026-10-15 16:30 = 北京时间 2026-10-16 00:30
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(generateOrderNo(at('2026-10-15T16:30:00Z'))).toMatch(/^O20261015-/);
  });

  it('随机部分始终是纯数字，不带小数点或科学计数法', () => {
    for (const r of [0.0000001, 0.1234567, 0.9999999]) {
      jest.spyOn(Math, 'random').mockReturnValue(r);
      expect(generateOrderNo(at('2026-10-15T00:00:00Z'))).toMatch(/^O\d{8}-\d{9}$/);
      jest.restoreAllMocks();
    }
  });
});
