import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 管理员账号体系 + 操作审计（2026-10-10）。
 *
 * 背景：管理端原先用静态 `X-Admin-Key`，**无法区分操作人**——
 * `POST /admin/recharges/:id/confirm?admin_id=` 的经办人由前端自报，可被任意伪造，
 * 而核销充值、禁用用户、重置密码都是资金/权限操作，出了问题必须能追到人。
 *
 * 方案：管理员就是 `role='admin'` 的普通用户（复用登录/argon2id/JWT/refresh），
 * 另建审计表，`operator_id` 一律取自已验证的 JWT。
 */
export class AdminRolesAndAudit1759900000000 implements MigrationInterface {
  name = 'AdminRolesAndAudit1759900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) u_user 加 role（默认 user，存量行自动落 user）
    const hasRole = await queryRunner.hasColumn('u_user', 'role');
    if (!hasRole) {
      await queryRunner.query(
        `ALTER TABLE \`u_user\`
           ADD COLUMN \`role\` VARCHAR(16) NOT NULL DEFAULT 'user'
           COMMENT 'user 普通用户 / admin 管理员'
           AFTER \`password_hash\``,
      );
    }

    // 管理员查询（列表/统计/守卫判断"最后一个可用管理员"）会按 role+status 过滤
    const hasRoleIndex = await queryRunner.query(
      `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'u_user' AND INDEX_NAME = 'idx_user_role_status'`,
    );
    if (Number(hasRoleIndex?.[0]?.n ?? 0) === 0) {
      await queryRunner.query('ALTER TABLE `u_user` ADD INDEX `idx_user_role_status` (`role`, `status`)');
    }

    // 2) 审计日志表（只增不改不删）
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS \`a_audit_log\` (
        \`id\`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`operator_id\` VARCHAR(64)  NOT NULL COMMENT '操作人 u_user.id；系统动作为 system',
        \`operator\`    VARCHAR(64)  NOT NULL COMMENT '冗余用户名，便于展示与留存',
        \`action\`      VARCHAR(32)  NOT NULL COMMENT 'recharge_confirm / user_disable / ...',
        \`target\`      VARCHAR(64)  NULL COMMENT '如 apply:27 / user:01a1...',
        \`detail\`      JSON         NULL COMMENT '可读明细',
        \`ip\`          VARCHAR(45)  NULL COMMENT 'IPv6 最长 45',
        \`created_at\`  DATETIME(3)  NOT NULL,
        PRIMARY KEY (\`id\`),
        KEY \`idx_audit_action_created\` (\`action\`, \`created_at\`),
        KEY \`idx_audit_operator_created\` (\`operator_id\`, \`created_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        COMMENT='管理端操作审计日志'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `a_audit_log`');

    const hasRoleIndex = await queryRunner.query(
      `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'u_user' AND INDEX_NAME = 'idx_user_role_status'`,
    );
    if (Number(hasRoleIndex?.[0]?.n ?? 0) > 0) {
      await queryRunner.query('ALTER TABLE `u_user` DROP INDEX `idx_user_role_status`');
    }

    if (await queryRunner.hasColumn('u_user', 'role')) {
      await queryRunner.query('ALTER TABLE `u_user` DROP COLUMN `role`');
    }
  }
}
