/**
 * ISO 日期（`YYYY-MM-DD`）校验：**既查格式也查日历有效性**。
 *
 * 为什么不能只用正则：`2026-13-45` 能通过 `^\d{4}-\d{2}-\d{2}$`，
 * 但它不是合法日期。这种输入若放行，会在 SQL 的字符串比较里静默返回空结果
 * （用户看到"没有数据"而不是"参数错误"），排查时非常费劲 —— 实测踩过。
 */
export function isIsoDateString(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  // 借助 Date 的溢出回绕判断真实天数（如 2026-02-30 → 3 月 2 日）
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
