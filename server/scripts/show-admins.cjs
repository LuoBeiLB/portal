/**
 * 查看管理员账号实际存在哪里、存了哪些字段（只读诊断）。
 * 用法：node scripts/show-admins.cjs
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_DATABASE || 'cloud_portal',
  });

  const [tables] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE '%admin%'`,
  );
  console.log('--- 库里有没有 admin 相关的表 ---');
  console.log(tables.length ? tables.map((t) => `  ${t.TABLE_NAME}`).join('\n') : '  （没有！管理员不单独建表）');

  const [rows] = await conn.query(
    `SELECT id, username, phone, role, status,
            LEFT(password_hash, 22) AS hash_prefix, LENGTH(password_hash) AS hash_len,
            created_at, updated_at
       FROM u_user WHERE role = 'admin' ORDER BY created_at`,
  );
  console.log(`\n--- u_user 里 role='admin' 的行（${rows.length} 条）---`);
  for (const r of rows) {
    console.log(`  id       = ${r.id}`);
    console.log(`  username = ${r.username}`);
    console.log(`  phone    = ${r.phone ?? '(null)'}`);
    console.log(`  role     = ${r.role}`);
    console.log(`  status   = ${r.status}`);
    console.log(`  密码哈希  = ${r.hash_prefix}…（共 ${r.hash_len} 字符，argon2id）`);
    console.log(`  created  = ${r.created_at}`);
    console.log('');
  }

  const [counts] = await conn.query(
    `SELECT role, COUNT(*) AS n FROM u_user GROUP BY role`,
  );
  console.log('--- u_user 按角色统计 ---');
  for (const c of counts) console.log(`  ${String(c.role).padEnd(8)} ${c.n} 行`);

  const [wallets] = await conn.query(
    `SELECT w.user_id, w.balance_cents, w.status
       FROM w_wallet w JOIN u_user u ON u.id = w.user_id WHERE u.role = 'admin'`,
  );
  console.log(`\n--- 管理员也有钱包（${wallets.length} 个）---`);
  for (const w of wallets) console.log(`  ${w.user_id}  balance=${w.balance_cents}  status=${w.status}`);

  await conn.end();
})().catch((error) => {
  console.error('失败:', error.message);
  process.exit(1);
});
