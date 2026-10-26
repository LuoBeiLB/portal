import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 企业账号体系（2026-10-19）。对应 `docs/24-企业版权限落地实施文档.md` 的 M1。
 *
 * ## 这次迁移解决什么
 *
 * 门户原本只有「个人用户」一种账号：注册即建钱包、自助充值下单。企业版要求相反的规则
 * ——账号由**企业**拥有、**不能**自助充值、余额恒为 0。所以必须把"账号性质"变成一个字段，
 * 而不是靠外部名单判断。
 *
 * ## 三个概念（互相正交，别混）
 *
 * | 维度 | 字段 | 回答什么 |
 * |---|---|---|
 * | 管理权限 | `u_user.role` | 这个人**是不是门户管理员**（能否进 `/api/admin/*`） |
 * | 账号性质 | `u_user.user_type` | **个人**还是**企业员工**（决定能否充值下单） |
 * | 企业归属 | `u_user.enterprise_id` | 属于**哪家企业**（产品侧建立租户上下文的依据） |
 *
 * ## 为什么用 pending 状态
 *
 * 企业所有者必须是本企业员工（`user_type=1` 要求 `enterprise_id` 非空），但企业又必须先存在
 * —— 这是个循环。解法是把"建企业"和"指定所有者"拆成两步：
 *
 * 1. 建企业 → `status='pending'`、`owner_user_id=NULL`
 * 2. 建/绑所有者账号（此时企业已有 id，CHECK 约束过得去）
 * 3. 回填 `owner_user_id` 并置 `status='active'`
 *
 * 所以 `owner_user_id` **必须允许为空**。若设成 `NOT NULL`，第 1 步就插不进去。
 * `pending` 企业一律不允许登录与调用企业端接口。
 *
 * ## 组合约束（⚠️ 本环境是 MySQL 5.7，CHECK 会被静默忽略）
 *
 * 三条组合在业务上永远非法：
 *
 * - `user_type=1` ⇒ `enterprise_id` 必须非空（企业员工没有企业，产品侧无法确定租户）
 * - `user_type=0` ⇒ `enterprise_id` 必须为空（个人用户挂企业 id 会造成语义混乱）
 * - `admin` 角色 ⇒ 不能是 `user_type=1`（否则既绕过企业限制又持有平台权限）
 *
 * **已实测**：本机/测试库是 **MySQL 5.7.26**，`ALTER TABLE ... ADD CONSTRAINT ... CHECK`
 * 会**执行成功但完全不生效**（5.7 只解析不执行；8.0.16 起才真正检查）。
 * 所以这里按版本分支：
 *
 * - `>= 8.0.16`：真的加上，数据库兜底
 * - `< 8.0.16`：**跳过并打日志**，只靠应用层保证。不做这一步的话，表上会出现
 *   "有约束但拦不住"的假象，比没有更危险
 *
 * 5.7 环境下的兜底手段是 `scripts/check/check-user-enterprise-consistency.cjs`
 * 巡检脚本（定期跑，发现脏数据再修）。
 *
 * ## `must_change_password`
 *
 * 企业管理员建员工号时给的是**初始密码**，首登必须改。`u_user` 原本没有这个列，本次补上。
 * 注意：本迁移只加列与默认值，**不在迁移里强制任何行为**。
 *
 * 详见 `docs/22-门户权限管理方案.md` §3.2 与 `docs/23` 图①。
 */
export class EnterpriseAccounts1760000000000 implements MigrationInterface {
  name = 'EnterpriseAccounts1760000000000';

  private async tableExists(queryRunner: QueryRunner, table: string): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
      [table],
    )) as unknown[];
    return rows.length > 0;
  }

  private async columnSet(queryRunner: QueryRunner, table: string): Promise<Set<string>> {
    const rows = (await queryRunner.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    )) as Array<{ c: string }>;
    return new Set(rows.map((r) => r.c));
  }

  private async indexExists(queryRunner: QueryRunner, table: string, index: string): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [table, index],
    )) as unknown[];
    return rows.length > 0;
  }

  /**
   * 当前库是否真正支持 CHECK 约束（MySQL 8.0.16+）。
   *
   * 5.7 的行为是**接受语句但忽略约束**，不加这个判断就会写出"看起来有约束、
   * 实际拦不住"的迁移——比没有约束更难排查。
   */
  private async supportsCheckConstraint(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`SELECT VERSION() AS v`)) as Array<{ v: string }>;
    const version = rows[0]?.v ?? '0.0.0';
    const [major = 0, minor = 0, patch = 0] = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
    if (major > 8) return true;
    if (major < 8) return false;
    if (minor > 0) return true;
    return patch >= 16;
  }

  private async constraintExists(queryRunner: QueryRunner, table: string, name: string): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`,
      [table, name],
    )) as unknown[];
    return rows.length > 0;
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    /* ---------- 1. enterprise（租户根，门户侧只存身份，不存产品内的组织）---------- */
    if (!(await this.tableExists(queryRunner, 'enterprise'))) {
      await queryRunner.query(`
        CREATE TABLE enterprise (
          id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          code          VARCHAR(64)  NOT NULL COMMENT '企业编码，对接用；建好后不可改',
          name          VARCHAR(128) NOT NULL COMMENT '企业名称',
          status        VARCHAR(16)  NOT NULL DEFAULT 'pending'
                        COMMENT 'pending 待指定所有者（不可用）/ active 正常 / disabled 停用（永不删除）',
          quota_bytes   BIGINT       NOT NULL DEFAULT 0 COMMENT '企业总配额（字节，0 = 不限）',
          owner_user_id CHAR(36)     NULL COMMENT '企业所有者 = 唯一管理员 + 资源默认持有人；pending 时为空',
          expire_at     DATETIME(3)  NULL COMMENT '服务到期时间（可空）',
          created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          UNIQUE KEY uk_enterprise_code (code),
          KEY idx_enterprise_status (status),
          KEY idx_enterprise_owner (owner_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
          COMMENT='企业（租户根）；账号归属的权威来源在门户'
      `);
    }

    /* ---------- 2. u_user 三个新列 ---------- */
    const cols = await this.columnSet(queryRunner, 'u_user');

    if (!cols.has('user_type')) {
      await queryRunner.query(
        `ALTER TABLE u_user ADD COLUMN user_type TINYINT NOT NULL DEFAULT 0
           COMMENT '0 个人 / 1 企业员工（注册接口写死 0，不接受请求体传入）' AFTER role`,
      );
    }
    if (!cols.has('enterprise_id')) {
      await queryRunner.query(
        `ALTER TABLE u_user ADD COLUMN enterprise_id BIGINT UNSIGNED NULL
           COMMENT '所属企业；user_type=1 时必填，user_type=0 时必须为空' AFTER user_type`,
      );
    }
    if (!cols.has('must_change_password')) {
      await queryRunner.query(
        `ALTER TABLE u_user ADD COLUMN must_change_password TINYINT NOT NULL DEFAULT 0
           COMMENT '1 首登必须改密（企业管理员建号时置 1）' AFTER status`,
      );
    }

    /* ---------- 3. 索引 ---------- */
    if (!(await this.indexExists(queryRunner, 'u_user', 'idx_user_enterprise'))) {
      await queryRunner.query(`ALTER TABLE u_user ADD KEY idx_user_enterprise (enterprise_id, user_type)`);
    }

    /* ---------- 4. 组合约束（MySQL 5.7 会忽略 CHECK，按版本分支）---------- */
    if (await this.supportsCheckConstraint(queryRunner)) {
      if (!(await this.constraintExists(queryRunner, 'u_user', 'ck_user_enterprise_type'))) {
        await queryRunner.query(`
          ALTER TABLE u_user ADD CONSTRAINT ck_user_enterprise_type
            CHECK ((user_type = 1 AND enterprise_id IS NOT NULL)
                OR (user_type = 0 AND enterprise_id IS NULL))
        `);
      }
      if (!(await this.constraintExists(queryRunner, 'u_user', 'ck_user_admin_not_enterprise'))) {
        await queryRunner.query(`
          ALTER TABLE u_user ADD CONSTRAINT ck_user_admin_not_enterprise
            CHECK (NOT (role = 'admin' AND user_type = 1))
        `);
      }
    } else {
      /*
       * MySQL < 8.0.16：CHECK 加了也不生效，**故意不加** —— 否则表结构上会出现
       * "有约束"的假象。这类环境的兜底是应用层校验 + 巡检脚本：
       *   node scripts/check/check-user-enterprise-consistency.cjs
       */
      // eslint-disable-next-line no-console
      console.warn(
        '[migration] 当前 MySQL < 8.0.16，跳过 u_user 的 CHECK 约束（引擎会静默忽略）。' +
          '组合合法性由应用层保证，请定期跑 check-user-enterprise-consistency.cjs 巡检。',
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.constraintExists(queryRunner, 'u_user', 'ck_user_admin_not_enterprise')) {
      await queryRunner.query(`ALTER TABLE u_user DROP CHECK ck_user_admin_not_enterprise`);
    }
    if (await this.constraintExists(queryRunner, 'u_user', 'ck_user_enterprise_type')) {
      await queryRunner.query(`ALTER TABLE u_user DROP CHECK ck_user_enterprise_type`);
    }
    if (await this.indexExists(queryRunner, 'u_user', 'idx_user_enterprise')) {
      await queryRunner.query(`ALTER TABLE u_user DROP KEY idx_user_enterprise`);
    }

    const cols = await this.columnSet(queryRunner, 'u_user');
    if (cols.has('must_change_password')) {
      await queryRunner.query(`ALTER TABLE u_user DROP COLUMN must_change_password`);
    }
    if (cols.has('enterprise_id')) {
      await queryRunner.query(`ALTER TABLE u_user DROP COLUMN enterprise_id`);
    }
    if (cols.has('user_type')) {
      await queryRunner.query(`ALTER TABLE u_user DROP COLUMN user_type`);
    }

    if (await this.tableExists(queryRunner, 'enterprise')) {
      await queryRunner.query(`DROP TABLE enterprise`);
    }
  }
}
