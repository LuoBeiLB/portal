/**
 * 一键准备 e2e 独立测试库（2026-10-12）。
 *
 * ## 为什么需要独立库
 *
 * 开发者常在自己机器上跑着一个门户实例（读 `.env` → 真实云存储），它每 10 分钟
 * 把 `p_product` / `p_product_sync_log` 覆盖成**真实商品**。而 e2e 脚本会先清空这两张表，
 * 并断言"`storage-500g` = 3000 分"（产品桩的价）——
 * 被真实价（50000）冲掉后，表现为"莫名其妙的价格不符失败"，**跑之前完全看不出来**。
 *
 * 用独立库后，e2e 与运营库彻底隔离，也不再污染正在使用的数据。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/setup-test-db.cjs          # 建库（若不存在）+ 跑全部迁移
 * node scripts/setup-test-db.cjs --reset  # 先 DROP 再重建（数据全清）
 * ```
 *
 * 之后跑 `run-e2e-round3.ps1` / `run-e2e-refund.ps1` 会自动用它（脚本内注入 DB_DATABASE）。
 */
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const DB_NAME = process.env.E2E_DATABASE || 'cloud_portal_e2e';
const reset = process.argv.includes('--reset');

const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || 'root',
  });

  const [found] = await conn.query('SHOW DATABASES LIKE ?', [DB_NAME]);
  const existed = found.length > 0;

  if (reset && existed) {
    console.log(`  删除旧测试库 ${DB_NAME} …`);
    await conn.query(`DROP DATABASE \`${DB_NAME}\``);
  }

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
  );
  console.log(
    existed && !reset ? `  测试库 ${DB_NAME} 已存在（保留数据；要清空请加 --reset）` : `  测试库 ${DB_NAME} 已创建`,
  );
  await conn.end();

  // 跑迁移：与 data-source.ts 同源，保证表结构与运营库一致
  console.log('  执行迁移 …');
  const cli = resolve(process.cwd(), 'node_modules/typeorm/cli-ts-node-commonjs.js');
  if (!existsSync(cli)) {
    console.error(`  ✗ 找不到 ${cli}（请先在 portal/server 下 npm install）`);
    process.exit(1);
  }

  const result = spawnSync(
    process.execPath,
    [cli, 'migration:run', '-d', 'src/database/data-source.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DB_DATABASE: DB_NAME },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    console.error('  ✗ 迁移失败，详见上面的输出');
    process.exit(result.status ?? 1);
  }

  // 校验：表与迁移记录都在
  const check = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: DB_NAME,
  });
  const [tables] = await check.query('SHOW TABLES');
  const key = Object.keys(tables[0] ?? {})[0];
  const names = key ? tables.map((row) => row[key]) : [];
  const [migrations] = await check.query('SELECT COUNT(*) AS n FROM typeorm_migrations');
  await check.end();

  console.log(`  完成：${names.length} 张表，${migrations[0].n} 条迁移记录`);
  console.log(`\n  用它的方式（脚本已内置，这里是手工场景）：`);
  console.log(`    $env:DB_DATABASE='${DB_NAME}'; $env:APP_PORT='3300'`);
  console.log(`    node dist/main.js`);
})().catch((error) => {
  console.error('失败：', error.message);
  process.exit(1);
});
