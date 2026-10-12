/**
 * 定位 DATETIME 的 8 小时偏移到底出在哪一层。
 *
 * 现象：同一行里 `started_at`（应用写的）比 `created_at`（库生成的）早 8 小时。
 * 做法：分别测四件事
 *   ① 驱动写入一个 Date 时，落到库里是什么值
 *   ② 库侧 CURRENT_TIMESTAMP(3) 生成的是什么值
 *   ③ TypeORM @CreateDateColumn 走的是哪条路
 *   ④ 读回来时驱动又做了什么转换
 *
 * 用法：node scripts/diag-datetime-offset.cjs
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const mysql = require('mysql2/promise');

const CFG = {
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USERNAME || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_DATABASE || 'cloud_portal',
};

const TABLE = 'tmp_datetime_probe';

(async () => {
  // 两条连接：一条拿原始字符串（dateStrings），一条走正常的 Date 解析
  const raw = await mysql.createConnection({ ...CFG, dateStrings: true });
  const parsed = await mysql.createConnection({ ...CFG });

  console.log('=== 时区事实 ===');
  const [tz] = await raw.query('SELECT @@global.time_zone g, @@session.time_zone s, NOW() now_, UTC_TIMESTAMP() utc, @@system_time_zone sys');
  console.log(`  @@global.time_zone  = ${tz[0].g}`);
  console.log(`  @@session.time_zone = ${tz[0].s}`);
  console.log(`  @@system_time_zone  = ${tz[0].sys}`);
  console.log(`  NOW()               = ${tz[0].now_}`);
  console.log(`  UTC_TIMESTAMP()     = ${tz[0].utc}`);
  console.log(`  node new Date()     = ${new Date().toString()}`);
  console.log(`  node toISOString()  = ${new Date().toISOString()}`);
  console.log(`  进程时区偏移        = ${-new Date().getTimezoneOffset() / 60} 小时`);

  await raw.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await raw.query(
    `CREATE TABLE ${TABLE} (
       id INT AUTO_INCREMENT PRIMARY KEY,
       from_node_utc   DATETIME(3) NULL COMMENT '应用写 new Date()',
       from_db_now     DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '库生成',
       from_utc_func   DATETIME(3) NULL COMMENT '应用写库侧 UTC_TIMESTAMP()',
       from_local_str  DATETIME(3) NULL COMMENT '应用写本地时间字符串'
     )`,
  );

  const marker = new Date();
  // ① 走 mysql2 的 Date 参数绑定（TypeORM 也是这条路）
  await parsed.query(`INSERT INTO ${TABLE} (from_node_utc, from_utc_func, from_local_str) VALUES (?, UTC_TIMESTAMP(3), ?)`, [
    marker,
    `${marker.getFullYear()}-${String(marker.getMonth() + 1).padStart(2, '0')}-${String(marker.getDate()).padStart(2, '0')} ${String(marker.getHours()).padStart(2, '0')}:${String(marker.getMinutes()).padStart(2, '0')}:${String(marker.getSeconds()).padStart(2, '0')}.000`,
  ]);

  const [rows] = await raw.query(`SELECT id, from_node_utc, from_db_now, from_utc_func, from_local_str FROM ${TABLE} ORDER BY id DESC LIMIT 1`);
  const row = rows[0];

  console.log('\n=== ① 应用写 Date 参数 → 库里实际存了什么（原始字符串）===');
  console.log(`  应用给的瞬间(UTC)      = ${marker.toISOString()}`);
  console.log(`  应用给的瞬间(本地)     = ${marker.toString()}`);
  console.log(`  from_node_utc         = ${row.from_node_utc}`);
  console.log(`  from_db_now (库生成)   = ${row.from_db_now}`);
  console.log(`  from_utc_func         = ${row.from_utc_func}`);
  console.log(`  from_local_str        = ${row.from_local_str}`);

  const utcWall = marker.toISOString().replace('T', ' ').replace('Z', '');
  const localWall = `${marker.getFullYear()}-${String(marker.getMonth() + 1).padStart(2, '0')}-${String(marker.getDate()).padStart(2, '0')} ${String(marker.getHours()).padStart(2, '0')}:${String(marker.getMinutes()).padStart(2, '0')}:${String(marker.getSeconds()).padStart(2, '0')}`;
  const startsWith = (value, prefix) => String(value).startsWith(prefix.slice(0, 19));

  console.log('\n=== ② 结论：驱动写入的是"UTC 墙面时间"还是"本地墙面时间" ===');
  console.log(`  与 UTC 墙面时间(${utcWall.slice(11, 19)})一致？   ${startsWith(row.from_node_utc, utcWall) ? '是 ← 驱动按 UTC 序列化' : '否'}`);
  console.log(`  与本地墙面时间(${localWall.slice(11, 19)})一致？  ${startsWith(row.from_node_utc, localWall) ? '是 ← 驱动按本地序列化' : '否'}`);
  console.log(`  库生成的 NOW 与本地墙面一致？                    ${startsWith(row.from_db_now, localWall) ? '是（session tz = 系统时区）' : '否'}`);

  console.log('\n=== ③ 读回来时驱动做了什么 ===');
  const [parsedRows] = await parsed.query(`SELECT from_node_utc, from_db_now FROM ${TABLE} ORDER BY id DESC LIMIT 1`);
  const asDateUtc = parsedRows[0].from_node_utc;
  const asDateDb = parsedRows[0].from_db_now;
  console.log(`  from_node_utc: 原始="${row.from_node_utc}"  驱动解析成 ${asDateUtc instanceof Date ? asDateUtc.toISOString() : asDateUtc}  本地显示 ${asDateUtc instanceof Date ? asDateUtc.toString().slice(16, 24) : '-'}`);
  console.log(`  from_db_now  : 原始="${row.from_db_now}"  驱动解析成 ${asDateDb instanceof Date ? asDateDb.toISOString() : asDateDb}  本地显示 ${asDateDb instanceof Date ? asDateDb.toString().slice(16, 24) : '-'}`);
  console.log(`  两列的 UTC 差值（小时）= ${asDateUtc && asDateDb ? (asDateDb.getTime() - asDateUtc.getTime()) / 3_600_000 : '?'}`);

  console.log('\n=== ④ 真实表里的同类现象（p_product_sync_log）===');
  const [sync] = await raw.query('SELECT id, started_at, finished_at, created_at FROM p_product_sync_log ORDER BY id DESC LIMIT 3');
  for (const r of sync) {
    const startWall = new Date(String(r.started_at).replace(' ', 'T') + 'Z');
    const createdWall = new Date(String(r.created_at).replace(' ', 'T') + 'Z');
    console.log(
      `  id=${r.id}  started_at=${r.started_at}  created_at=${r.created_at}  ` +
        `差=${((createdWall - startWall) / 3_600_000).toFixed(1)}h`,
    );
  }

  await raw.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await raw.end();
  await parsed.end();
  console.log('\n（临时表已清理）');
})().catch(async (error) => {
  console.error('失败：', error.message);
  process.exit(1);
});
