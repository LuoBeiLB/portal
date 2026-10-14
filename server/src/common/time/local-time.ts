/**
 * 统一时间口径（2026-10-12 定稿）。
 *
 * ## 一条规则
 *
 * > **接口返回的时间字符串，直接展示给用户，不要做任何时区转换。**
 *
 * ## 为什么
 *
 * 库里两类时间列的写入者不同，但**读写两侧的 8 小时偏移正好抵消**，
 * 所以对外输出的字符串就是"用户该看到的墙上时间"：
 *
 * | | 库里存 | 驱动读成 | 对外输出 | 前端 |
 * |---|---|---|---|---|
 * | **库生成列**（16 个：`created_at` / `updated_at` / `synced_at`） | 本地墙面 `10:39` | `10:39Z` | `10:39Z` | 直接展示 ✅ |
 * | **应用写列**（6 个：`paid_at` / `started_at` / `finished_at` / `next_run_at` / `reviewed_at` / `expire_at`） | UTC 墙面 `02:39` | `02:39Z` | `02:39Z` | 直接展示 ✅ |
 *
 * 两行都是"同一时刻的墙上时间"，只是库里存的字面量不同。
 * 读出来时驱动把两者都按 UTC 解析（连接参数 `timezone: 'Z'`），
 * 而写的时候应用写 UTC、库写本地 —— 偏移互相抵消。
 *
 * ## 前端要改什么
 *
 * **去掉 UTC→本地的转换**。如果现在写了 `dayjs(ts).local()` 或
 * `new Date(ts).toLocaleString()`，那会把 `10:39Z` 变成 `18:39`，多 8 小时。
 * 改成 `dayjs(ts).utc()`（保持原样格式化）或直接按字符串截取。
 *
 * 这是**破坏性变更**，已在 `docs/09-契约v1.1差异与补充.md` 登记。
 *
 * ## 后端注意
 *
 * 1. **写库生成列时不要显式给值** —— `@CreateDateColumn` 会让 TypeORM 序列化成 UTC 墙面时间，
 *    与库生成的本地墙面时间混在一行里就是"同一行差 8 小时"。已全部换成
 *    显式 `@Column({ default: () => 'CURRENT_TIMESTAMP(3)' })`。
 * 2. **写业务时刻用 `utcWallTime()`**（或 `new Date()`，TypeORM 的默认行为就是 UTC 墙面），
 *    **不要**改成"本地墙面" —— 那样 `nextRunAt` 之类的内部比较会整体错 8 小时。
 * 3. 需要"真实时刻"做运算时，用 `toInstant()`；对外输出用现有的 `toIso()` / `iso()` 即可
 *    （它们读的是 UTC 分量，正好是墙上时间）。
 */

/** 服务器时区相对 UTC 的偏移（分钟）：本机 +08:00 → 480 */
export function timezoneOffsetMinutes(at: Date = new Date()): number {
  return -at.getTimezoneOffset();
}

/** `2026-10-12T02:39:58.470Z` 形状的 UTC 墙面时间字符串（写库用） */
export function utcWallTime(at: Date = new Date()): string {
  return at.toISOString();
}

/**
 * 由"UTC 墙面时间字符串"还原**真实时刻**（用于跨字段比较、算时长）。
 *
 * 例：库里 `02:39:58` 是 UTC 墙面（应用写的）→ 驱动给 `02:39:58Z` → 真实时刻就是它。
 * 例：库里 `10:39:58` 是本地墙面（库生成的）→ 驱动给 `10:39:58Z` →
 * 真实时刻是 `02:39:58Z`，即需要减 8 小时。
 *
 * 所以本函数只对**库生成列**有意义；应用写列本身就是真实时刻。
 * 判断依据见 `scripts/tools/diag-datetime-columns.cjs` 输出的列清单。
 */
export function databaseGeneratedToInstant(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() - timezoneOffsetMinutes(date) * 60_000);
}

/**
 * 把驱动读回来的 `Date` 转成**真实时刻的 ISO 串**（对外输出用，用于"应用写"的列）。
 *
 * 应用写的业务时刻（`paid_at` / `expire_at` / `reviewed_at`）在库里是 **UTC 墙面时间**，
 * 驱动按 UTC 解析后就是**真实时刻**，所以直接 `toISOString()` 即可。
 * 但接口约定返回的是"墙上时间"（与库生成列同形），因此这里补一次本地偏移，
 * 让 `02:39Z`（真实 UTC）变成 `10:39Z`（墙上时间）。
 *
 * 与各模块现有的 `toIso()` / `iso()` 区别：那两个用于**库生成列**（读 UTC 分量、不补偏移），
 * 本函数用于**应用写列**（补本地偏移）。
 *
 * ⚠️ 只用于展示型字段。参与内部运算的字段（`next_run_at` / `claimed_at`）不要经它转换。
 */
export function instantToWallIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + timezoneOffsetMinutes(date) * 60_000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 把驱动读回来的 `Date` 转成**墙上时间的 ISO 串**（对外输出用，用于"库生成"的列）。
 *
 * 与各模块现有的 `toIso()` / `iso()` 等价（都读 UTC 分量、截到秒）。
 * 放在这里是为了让"为什么读 UTC 分量"这件事有出处。
 */
export function toWallIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
