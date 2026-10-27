import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 企业注册审核 + 企业管理员角色（2026-10-27）。对应 v2 设计稿
 * （\`docs/original/2026-10-26-管理端-企业与角色权限重构设计-v2.md\`）与 \`docs/24\` 的 M1。
 *
 * ## 背景：v1 → v2 的两处模型修正
 *
 * 1. **v1 判"是不是企业管理员"用 \`enterprise.owner_user_id === me\`**
 *    —— 一个企业只能有一个管理员，也没法扩。
 *    v2 改用 \`u_user.enterprise_role\`（0 成员 / 1 管理员），\`owner_user_id\` 降级为
 *    "创建者 / 主管理员"（只用于资源归属与将来转让）。
 *
 * 2. **v1 的企业是平台代建的**，没有审核概念。
 *    v2 是**企业方在 C 端自助注册**，注册后 \`pending\`，平台审核通过才 \`active\`。
 *    所以 \`enterprise\` 要补审核相关字段，\`status\` 多一个 \`rejected\`。
 *
 * ## 这次迁移做什么
 *
 * 1. \`enterprise\` 新增：\`contact_name\` / \`contact_phone\` / \`remark\` /
 *    \`reviewed_at\` / \`reviewed_by\` / \`reject_reason\`
 * 2. \`u_user\` 新增 \`enterprise_role\`（NULL = 非企业账号）
 * 3. **删除 \`quota_bytes\`** —— 企业没有配额概念（资源包归主管理员个人，见 docs/21 §9.2）
 * 4. 存量回填：\`user_type=1\` 的一律 \`enterprise_role=0\`，
 *    其中 \`owner_user_id\` 指向的那个置 1
 *
 * ## \`status\` 为什么不用改类型
 *
 * 建表时就是 \`VARCHAR(16)\`（见 \`1760000000000-EnterpriseAccounts\`），
 * 加 \`rejected\` 只是应用层多一个合法值，不需要 DDL。
 *
 * ## 为什么删 \`quota_bytes\` 是安全的
 *
 * 该列从未承载过真实业务：企业配额从来都是"资源包之和"，而资源包归主管理员个人。
 * 上线前删掉，避免它继续误导人以为"企业有配额"。
 */
export class EnterpriseReviewAndRole1761000000000 implements MigrationInterface {
  name = 'EnterpriseReviewAndRole1761000000000';

  private async columnSet(queryRunner: QueryRunner, table: string): Promise<Set<string>> {
    const rows = (await queryRunner.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    )) as Array<{ c: string }>;
    return new Set(rows.map((r) => r.c));
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    /* ---------- 1. enterprise：注册联系人与审核字段 ---------- */
    const entCols = await this.columnSet(queryRunner, 'enterprise');

    if (!entCols.has('contact_name')) {
      await queryRunner.query(
        `ALTER TABLE enterprise ADD COLUMN contact_name VARCHAR(64) NULL
           COMMENT '注册联系人' AFTER name`,
      );
    }
    if (!entCols.has('contact_phone')) {
      await queryRunner.query(
        `ALTER TABLE enterprise ADD COLUMN contact_phone VARCHAR(32) NULL
           COMMENT '注册联系电话' AFTER contact_name`,
      );
    }
    if (!entCols.has('remark')) {
      await queryRunner.query(
        `ALTER TABLE enterprise ADD COLUMN remark VARCHAR(255) NULL
           COMMENT '注册备注（企业方填写）' AFTER contact_phone`,
      );
    }
    if (!entCols.has('reviewed_at')) {
      await queryRunner.query(
        `ALTER TABLE enterprise ADD COLUMN reviewed_at DATETIME(3) NULL
           COMMENT '审核时间' AFTER status`,
      );
    }
    if (!entCols.has('reviewed_by')) {
      await queryRunner.query(
        `ALTER TABLE enterprise ADD COLUMN reviewed_by CHAR(36) NULL
           COMMENT '审核人（平台管理员 u_user.id）' AFTER reviewed_at`,
      );
    }
    if (!entCols.has('reject_reason')) {
      await queryRunner.query(
        `ALTER TABLE enterprise ADD COLUMN reject_reason VARCHAR(255) NULL
           COMMENT '驳回原因（驳回必填）' AFTER reviewed_by`,
      );
    }

    /* ---------- 2. u_user：企业内角色 ---------- */
    const userCols = await this.columnSet(queryRunner, 'u_user');
    if (!userCols.has('enterprise_role')) {
      await queryRunner.query(
        `ALTER TABLE u_user ADD COLUMN enterprise_role TINYINT NULL
           COMMENT '企业内角色：0 成员 / 1 管理员；NULL 表示非企业账号' AFTER enterprise_id`,
      );

      /*
       * 存量回填：user_type=1 的一律先当普通成员，再按 owner_user_id 升管理员。
       * 这两句顺序不能反 —— 否则先把人升成 1、又被"先全置 0"覆盖掉。
       */
      await queryRunner.query(`UPDATE u_user SET enterprise_role = 0 WHERE user_type = 1`);
      await queryRunner.query(`
        UPDATE u_user u
          JOIN enterprise e ON e.owner_user_id = u.id
           SET u.enterprise_role = 1
      `);
    }

    /* ---------- 3. 删除企业配额列（企业没有配额概念）---------- */
    if (entCols.has('quota_bytes')) {
      await queryRunner.query(`ALTER TABLE enterprise DROP COLUMN quota_bytes`);
    }

    /* ---------- 4. 审核页要按状态筛，补个索引 ---------- */
    const idxRows = (await queryRunner.query(
      `SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enterprise'
          AND INDEX_NAME = 'idx_enterprise_status_created' LIMIT 1`,
    )) as unknown[];
    if (idxRows.length === 0) {
      await queryRunner.query(
        `ALTER TABLE enterprise ADD KEY idx_enterprise_status_created (status, created_at)`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const entCols = await this.columnSet(queryRunner, 'enterprise');

    /* 恢复配额列：默认 0，历史值无法还原（本来就没有真值） */
    if (!entCols.has('quota_bytes')) {
      await queryRunner.query(
        `ALTER TABLE enterprise ADD COLUMN quota_bytes BIGINT NOT NULL DEFAULT 0
           COMMENT '企业总配额（字节，0 = 不限）' AFTER owner_user_id`,
      );
    }

    const idxRows = (await queryRunner.query(
      `SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enterprise'
          AND INDEX_NAME = 'idx_enterprise_status_created' LIMIT 1`,
    )) as unknown[];
    if (idxRows.length > 0) {
      await queryRunner.query(`ALTER TABLE enterprise DROP KEY idx_enterprise_status_created`);
    }

    for (const col of ['reject_reason', 'reviewed_by', 'reviewed_at', 'remark', 'contact_phone', 'contact_name']) {
      if (entCols.has(col)) {
        await queryRunner.query(`ALTER TABLE enterprise DROP COLUMN ${col}`);
      }
    }

    const userCols = await this.columnSet(queryRunner, 'u_user');
    if (userCols.has('enterprise_role')) {
      await queryRunner.query(`ALTER TABLE u_user DROP COLUMN enterprise_role`);
    }
  }
}
