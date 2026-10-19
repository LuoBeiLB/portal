import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 计费周期单位：**天 → 小时**（2026-10-14）。
 *
 * ## 为什么改
 *
 * `period_days` 粒度太粗，无法表达小时级商品：
 * 云电脑要上「体验 3 小时」这类包周期商品，用「天」只能填 `1`，会被算成 24 小时。
 *
 * 改成小时后：`3` = 3 小时、`24` = 1 天、`720` = 30 天。
 *
 * ## 为什么改字段名而不是只改单位
 *
 * 字段叫 `period_days` 却存小时，是长期的维护陷阱 —— 任何人看到这个字段都会默认它是天。
 * 改名 `period_hours` 后**名字自解释**，前后端和产品侧不用靠文档记单位。
 *
 * ## 本次迁移做什么
 *
 * 1. `p_product.period_days` → `p_product.period_hours`（列改名）
 * 2. **存量值 ×24**：原 `30`（30 天）→ 新 `720`（720 小时），**语义不变**
 *
 * ## 不需要做什么
 *
 * - **`o_order_item` 不存周期**（只快照价格），没有历史订单的周期数据要迁
 * - **`o_order_item.expire_at` 不动**：那是产品已经算好并返回的到期时间，改了会影响在期用户
 *
 * ## 兼容期说明
 *
 * 产品侧可能还没全改完，所以 `ProductSyncService` 会同时认 `period_hours` 和
 * `period_days`（后者 ×24 兜底）。等所有产品改完，删掉兼容分支即可。
 *
 * 详见 `docs/16-计费周期单位变更-接口与变更说明.md`。
 */
export class PeriodHours1759995000000 implements MigrationInterface {
  name = 'PeriodHours1759995000000';

  private static readonly COLUMN_COMMENT =
    '周期长度（小时）；billing_mode=1 必填。1天=24，30天=720';

  /** 查 p_product 现有列名（用于幂等判断） */
  private async columnSet(queryRunner: QueryRunner): Promise<Set<string>> {
    const rows = (await queryRunner.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'p_product'`,
    )) as Array<{ c: string }>;
    return new Set(rows.map((row) => row.c));
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const cols = await this.columnSet(queryRunner);
    const comment = PeriodHours1759995000000.COLUMN_COMMENT;

    if (cols.has('period_days') && !cols.has('period_hours')) {
      // 正常路径：列改名 + 存量值 ×24（语义不变）
      await queryRunner.query(
        `ALTER TABLE \`p_product\`
           CHANGE COLUMN \`period_days\` \`period_hours\` INT NULL COMMENT '${comment}'`,
      );
      await queryRunner.query(
        `UPDATE \`p_product\` SET \`period_hours\` = \`period_hours\` * 24 WHERE \`period_hours\` IS NOT NULL`,
      );
      return;
    }

    if (cols.has('period_days') && cols.has('period_hours')) {
      // 两列并存（有人手工加过）：先补数据，再删旧列
      await queryRunner.query(
        `UPDATE \`p_product\` SET \`period_hours\` = \`period_days\` * 24
          WHERE \`period_hours\` IS NULL AND \`period_days\` IS NOT NULL`,
      );
      await queryRunner.query(`ALTER TABLE \`p_product\` DROP COLUMN \`period_days\``);
      await queryRunner.query(
        `ALTER TABLE \`p_product\` MODIFY COLUMN \`period_hours\` INT NULL COMMENT '${comment}'`,
      );
      return;
    }

    if (!cols.has('period_hours')) {
      // 两列都不在（理论不会发生）：补列
      await queryRunner.query(
        `ALTER TABLE \`p_product\` ADD COLUMN \`period_hours\` INT NULL COMMENT '${comment}'`,
      );
    }
    // 只剩 period_hours：已迁移过，跳过
  }

  /**
   * 回滚：`period_hours` → `period_days`。
   *
   * ⚠️ **小时转天会丢精度**（`3` 小时 → `0` 天）。这是旧口径的固有限制，无法避免。
   * 回滚只用于开发环境；生产回滚应连同代码一起回到旧版本。
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const cols = await this.columnSet(queryRunner);
    if (!cols.has('period_hours')) return;

    // 先按 ×24 逆算回天（向下取整），再删列 —— 这样能尽量保留语义
    await queryRunner.query(
      `UPDATE \`p_product\` SET \`period_hours\` = FLOOR(\`period_hours\` / 24) WHERE \`period_hours\` IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`p_product\`
         CHANGE COLUMN \`period_hours\` \`period_days\` INT NULL COMMENT 'billing_mode=1 必填'`,
    );
  }
}
