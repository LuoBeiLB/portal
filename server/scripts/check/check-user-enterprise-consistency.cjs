/**
 * 巡检：`u_user` 的三条组合约束有没有被破坏。
 *
 * ## 为什么需要它
 *
 * 测试库/部分环境是 **MySQL 5.7**，它**接受但忽略 CHECK 约束**（8.0.16 起才真正执行）。
 * 所以迁移在 5.7 上会故意跳过 CHECK（见 `1760000000000-EnterpriseAccounts.ts`），
 * 组合合法性只剩应用层保证。应用层有脚本、后台改库、批量导入这些绕行路径，
 * 因此需要一条**定期跑的巡检**来发现脏数据。
 *
 * 用法：
 *   node scripts/check/check-user-enterprise-consistency.cjs
 *   node scripts/check/check-user-enterprise-consistency.cjs cloud_portal   # 指定库
 *
 * 退出码：0 = 干净；1 = 发现不一致（可直接接进定时任务告警）。
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const mysql = require('mysql2/promise');

const DATABASE = process.argv[2] || process.env.DB_DATABASE || 'cloud_portal';

/** 三条组合约束对应的查询 */
const RULES = [
  {
    name: '企业员工必须有企业',
    name_en: 'user_type=1 但 enterprise_id 为空',
    sql: 'SELECT id, username, user_type, enterprise_id FROM u_user WHERE user_type = 1 AND enterprise_id IS NULL',
  },
  {
    name: '个人用户不能挂企业',
    name_en: 'user_type=0 但 enterprise_id 非空',
    sql: 'SELECT id, username, user_type, enterprise_id FROM u_user WHERE user_type = 0 AND enterprise_id IS NOT NULL',
  },
  {
    name: '平台管理员不能是企业员工',
    name_en: "role='admin' 且 user_type=1",
    sql: "SELECT id, username, role, user_type FROM u_user WHERE role = 'admin' AND user_type = 1",
  },
  {
    name: '所有者必须存在且属于本企业',
    name_en: 'enterprise.owner_user_id 指向的账号不属于该企业或已不存在',
    sql: `SELECT e.id AS enterprise_id, e.code, e.owner_user_id, u.id AS user_id, u.enterprise_id AS user_enterprise_id
            FROM enterprise e
            LEFT JOIN u_user u ON u.id = e.owner_user_id
           WHERE e.owner_user_id IS NOT NULL
             AND (u.id IS NULL OR u.enterprise_id <> e.id)`,
  },
  {
    name: 'active 企业必须有所有者',
    name_en: "status='active' 但 owner_user_id 为空",
    sql: "SELECT id, code, status, owner_user_id FROM enterprise WHERE status = 'active' AND owner_user_id IS NULL",
  },
];

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DATABASE,
  });

  /* CHECK 约束在本库是否真的生效 —— 不生效就跑不了"最后一道防线"，要显式说明 */
  const [verRows] = await conn.query('SELECT VERSION() AS v');
  const version = String(verRows[0]?.v ?? '');
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const checkEnforced = major > 8 || (major === 8 && (minor > 0 || patch >= 16));

  const [ckRows] = await conn.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'u_user' AND CONSTRAINT_TYPE = 'CHECK'`,
    [DATABASE],
  );

  console.log(`巡检库：${DATABASE}（MySQL ${version}）`);
  console.log(
    `CHECK 约束：${checkEnforced ? '本版本支持' : '本版本**不支持**，引擎会静默忽略'}；` +
      `u_user 上已存在 ${ckRows.length} 条`,
  );
  if (!checkEnforced) {
    console.log('  → 组合合法性只剩应用层保证，本巡检验是唯一的发现手段，建议每天跑一次');
  }
  console.log('');

  let bad = 0;
  for (const rule of RULES) {
    const [rows] = await conn.query(rule.sql);
    if (rows.length === 0) {
      console.log(`  OK   ${rule.name}`);
      continue;
    }
    bad += rows.length;
    console.log(`  FAIL ${rule.name}（${rule.name_en}）→ ${rows.length} 行`);
    rows.slice(0, 10).forEach((r) => console.log('       ' + JSON.stringify(r)));
    if (rows.length > 10) console.log(`       …还有 ${rows.length - 10} 行`);
  }

  await conn.end();

  console.log('');
  if (bad === 0) {
    console.log('结果：全部通过，没有不一致数据。');
    process.exit(0);
  }
  console.log(`结果：发现 ${bad} 行不一致，需要修复。`);
  process.exit(1);
})().catch((error) => {
  console.error('巡检失败：', error.message);
  process.exit(1);
});
