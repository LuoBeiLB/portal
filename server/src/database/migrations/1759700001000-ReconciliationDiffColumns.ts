import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 第 3 轮补充：对账结果表增加差异分类列。
 * `createTableIfNotExists` 风格的增量迁移 —— 用 hasColumn 判断，重复执行安全。
 */
export class ReconciliationDiffColumns1759700001000 implements MigrationInterface {
  name = 'ReconciliationDiffColumns1759700001000';

  private readonly columns: Array<{ name: string; ddl: string }> = [
    { name: 'product_only_count', ddl: 'INT NOT NULL DEFAULT 0 COMMENT \'仅产品侧有（门户漏记/未回传）\'' },
    { name: 'portal_only_count', ddl: 'INT NOT NULL DEFAULT 0 COMMENT \'仅门户侧有（产品未上报）\'' },
    { name: 'amount_mismatch_count', ddl: 'INT NOT NULL DEFAULT 0 COMMENT \'两边都有但金额不一致\'' },
    { name: 'status', ddl: "VARCHAR(16) NOT NULL DEFAULT 'ok' COMMENT 'ok 平账 / diff 有差异'" },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const column of this.columns) {
      const exists = await queryRunner.hasColumn('r_reconciliation', column.name);
      if (!exists) {
        await queryRunner.query(`ALTER TABLE \`r_reconciliation\` ADD COLUMN \`${column.name}\` ${column.ddl}`);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of [...this.columns].reverse()) {
      const exists = await queryRunner.hasColumn('r_reconciliation', column.name);
      if (exists) {
        await queryRunner.query(`ALTER TABLE \`r_reconciliation\` DROP COLUMN \`${column.name}\``);
      }
    }
  }
}
