/**
 * 诊断：为什么 .env 改的 ADMIN_USERNAME/ADMIN_PASSWORD 没生效。
 *
 * 对比三边：① .env 里的配置 ② 数据库里实际的管理员 ③ 正在跑的服务进程
 * 用法：node scripts/diag-admin-bootstrap.cjs
 */
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const mysql = require('mysql2/promise');

(async () => {
  console.log('=== ① .env 文件里的配置 ===');
  console.log(`  路径: ${envPath}`);
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (/^ADMIN_/.test(line.trim())) {
      const [key, ...rest] = line.split('=');
      const value = rest.join('=');
      const shown = key.includes('PASSWORD') && value ? `${value.slice(0, 4)}…（${value.length} 字符）` : value;
      console.log(`  ${key.padEnd(16)} = ${shown}`);
    }
  }

  console.log('\n=== ② 进程环境里的配置（本次脚本读到的）===');
  console.log(`  ADMIN_USERNAME = ${process.env.ADMIN_USERNAME ?? '(未设置)'}`);
  console.log(`  ADMIN_PASSWORD = ${process.env.ADMIN_PASSWORD ? `${process.env.ADMIN_PASSWORD.slice(0, 4)}…` : '(未设置)'}`);

  console.log('\n=== ③ 数据库里实际的管理员 ===');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_DATABASE || 'cloud_portal',
  });
  const [rows] = await conn.query(
    `SELECT id, username, role, status, created_at, updated_at FROM u_user WHERE role='admin' ORDER BY created_at`,
  );
  for (const r of rows) {
    console.log(`  ${String(r.username).padEnd(28)} created=${r.created_at}  updated=${r.updated_at}`);
  }

  const [logCount] = await conn.query(
    `SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM a_audit_log WHERE action='system_bootstrap'`,
  );
  console.log(`\n  system_bootstrap 审计记录: ${logCount[0].n} 条，最近一次 ${logCount[0].latest ?? '-'}`);
  console.log('  （每次启动 bootstrap 都会写一条，据此可判断"启动后有没有跑过引导"）');

  const [bootstrapDetail] = await conn.query(
    `SELECT target, detail, created_at FROM a_audit_log
      WHERE action='system_bootstrap' ORDER BY id DESC LIMIT 5`,
  );
  console.log('\n  最近 5 条 bootstrap 记录：');
  for (const r of bootstrapDetail) {
    console.log(`    ${r.created_at}  target=${r.target}  detail=${JSON.stringify(r.detail)}`);
  }

  await conn.end();
})().catch((error) => {
  console.error('失败:', error.message);
  process.exit(1);
});
