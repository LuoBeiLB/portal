import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 统一时间列口径：**全部交给 MySQL 生成**（2026-10-12）。
 *
 * ## 背景：同一库里存在两套时间口径，差 8 小时
 *
 * `DATETIME` 不带时区，只是"墙上时间"字符串。实测（`scripts/diag-datetime-columns.cjs`）：
 *
 * | | A 类：库生成 | B 类：应用写入 |
 * |---|---|---|
 * | 列定义 | 有 `DEFAULT CURRENT_TIMESTAMP(3)` | 无库侧默认值 |
 * | 谁写 | MySQL | TypeORM |
 * | 序列化成 | `NOW()` → **本地墙面**（+08:00） | **UTC 墙面** |
 *
 * 同一刻写进两类列，字符串差 8 小时；读回来时驱动都按 UTC 解析（连接参数 `timezone: 'Z'`），
 * 于是 **A 类列返回给前端会整体 +8 小时**（`created_at` / `updated_at` / `synced_at` 全中），
 * 而 B 类反而是对的。
 *
 * 关键机制（`scripts/diag-orm-default.cjs` 验证）：
 * **只要应用不给值，TypeORM 生成的 INSERT 就是 `DEFAULT`**，让库来填：
 *
 * ```sql
 * INSERT INTO p_product(id, sku_id, created_at) VALUES (DEFAULT, ?, DEFAULT)
 * ```
 *
 * ## 本次决策：选"全部库生成"
 *
 * 代价是前端要**去掉一次时区转换**（它现在把 UTC 串转本地显示，而库生成的是本地墙面时间，
 * 再转一次会多 8 小时）。这是**破坏性变更**，已在 `docs/09` 登记，
 * 由用户确认「没上线，让前端改下问题不大」。
 *
 * ## 本迁移做什么
 *
 * 只补**缺默认值的列**。其余 A 类列在 `InitPortalSchema` 里已经带 `DEFAULT CURRENT_TIMESTAMP(3)`，
 * 不需要动（本迁移对已存在的默认值做幂等跳过）。
 *
 * > ⚠️ **不改历史数据**。已有的 A 类行存的是本地墙面、B 类行存的是 UTC 墙面，
 * > 两者混在一起无法可靠迁移（没有"这一列当时是谁写的"的记录）。
 * > 开发库直接忽略；如需在可用库上执行，先备份并人工确认口径。
 */
export class UnifyDatetimeDefaults1759990000000 implements MigrationInterface {
  name = 'UnifyDatetimeDefaults1759990000000';

  /** [表, 列, 该列是否已存在库侧默认值（由 information_schema 判定）] */
  public async up(queryRunner: QueryRunner): Promise<void> {
    // a_audit_log.created_at 由应用写入（审计写入时显式给 new Date()），是唯一缺默认值的 A 类列
    await this.ensureDefault(queryRunner, 'a_audit_log', 'created_at');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回滚成"应用写入"的形态：去掉库侧默认值
    await this.dropDefault(queryRunner, 'a_audit_log', 'created_at');
  }

  /** 幂等：列已有默认值就跳过 */
  private async ensureDefault(queryRunner: QueryRunner, table: string, column: string): Promise<void> {
    const existing = await this.currentDefault(queryRunner, table, column);
    if (existing !== null) {
      // eslint-disable-next-line no-console
      console.log(`[migration] ${table}.${column} 已有默认值 ${existing}，跳过`);
      return;
    }
    await queryRunner.query(
      `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（本地墙面时间，由库生成）'`,
    );
  }

  private async dropDefault(queryRunner: QueryRunner, table: string, column: string): Promise<void> {
    const existing = await this.currentDefault(queryRunner, table, column);
    if (existing === null) return;
    await queryRunner.query(
      `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` DATETIME(3) NOT NULL COMMENT '创建时间'`,
    );
  }

  /** 读该列的库侧默认值；无默认值返回 null */
  private async currentDefault(queryRunner: QueryRunner, table: string, column: string): Promise<string | null> {
    const rows = await queryRunner.query(
      `SELECT COLUMN_DEFAULT AS d FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    const value = rows?.[0]?.d;
    return value === undefined || value === null ? null : String(value);
  }
}
