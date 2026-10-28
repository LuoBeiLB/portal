#!/usr/bin/env node
/**
 * 登记产品公钥到 `p_service_key`（docs/27 §10）。
 *
 * 用法（在 portal/server 目录下）：
 *
 *   # 登记 / 更新一把公钥
 *   node scripts/ops/register-service-key.cjs register \
 *     --product phone --kid phone-2026-10 --pem ./keys/phone-public.pem \
 *     --expect-fingerprint 9bdae85b88e18945 --who 张贵林 --ticket OPS-123
 *
 *   # 看某个产品当前有哪些公钥（含指纹，便于和对方报的核对）
 *   node scripts/ops/register-service-key.cjs list --product phone
 *
 *   # 停用（泄漏止血）。下个刷新周期生效，不需要重启门户
 *   node scripts/ops/register-service-key.cjs disable --kid phone-2026-10
 *
 * 设计要点：
 *
 * 1. **拒收私钥**：PEM 里出现 `PRIVATE KEY` 直接失败。私钥一旦入库，
 *    等于把"签发任意身份"的能力扩散给所有能连数据库的人。
 * 2. **先规范化再入库**：`createPublicKey(pem).export(spki)`。
 *    门户启动时也用同样方式从私钥派生公钥，两边格式一致才能比对指纹。
 * 3. **`--expect-fingerprint` 是可选的强制核对**：公钥的真实性只能靠"对方在可信渠道
 *    报来的指纹"，没有这一步，中间人换一把公钥整套非对称签名就白做了。
 * 4. **幂等**：`ON DUPLICATE KEY UPDATE`，重复跑不会报 1062，且会把 `status` 拉回 0
 *    （便于"误停用后重新启用"）。
 * 5. **不重启**：入库后最迟 `SERVICE_KEY_RELOAD_INTERVAL_MS`（默认 60s）生效；
 *    若产品已切到新 `kid`，第一次请求会触发强刷，立即生效。
 *
 * 退出码：0 成功 · 1 参数或校验失败 · 2 数据库错误
 */

const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash, createPublicKey } = require('node:crypto');

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const mysql = require('mysql2/promise');

/** 门户已知的产品 code（`PRODUCT_*_BASE_URL` 对应的那三个） */
const KNOWN_PRODUCTS = ['storage', 'phone', 'desktop'];
/** kid 命名规范：`<product>-<yyyy-mm>` */
const KID_PATTERN = /^([a-z][a-z0-9_]{1,31})-(\d{4})-(0[1-9]|1[0-2])$/;
/** owner_code 规范（与表字段长度一致） */
const OWNER_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

function usage() {
  console.log(
    [
      '用法：',
      '  node scripts/ops/register-service-key.cjs register --product <code> --kid <kid> --pem <file>',
      '      [--expect-fingerprint <16hex>] [--who <名字>] [--ticket <单号>]',
      '      [--not-before <ISO>] [--not-after <ISO>] [--dry-run] [--force]',
      '  node scripts/ops/register-service-key.cjs list [--product <code>]',
      '  node scripts/ops/register-service-key.cjs disable --kid <kid> [--dry-run]',
      '',
      '环境：DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD / DB_DATABASE（默认读当前目录 .env）',
    ].join('\n'),
  );
}

/* ────────────────────────── 参数解析 ────────────────────────── */

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`无法识别的参数：${token}`);
    const key = token.slice(2);
    if (key === 'dry-run' || key === 'force') {
      flags[key] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 缺少取值`);
    flags[key] = value;
    i += 1;
  }
  return { command, flags };
}

/* ────────────────────────── 公钥处理 ────────────────────────── */

/**
 * 读取并校验收到的公钥，返回**规范化后的 SPKI PEM** 与指纹。
 *
 * 指纹口径必须与门户 `kidFingerprint()` 一致：`sha256(PEM 字符串)` 取前 16 位 hex。
 */
function loadPublicKey(pemPath) {
  const abs = resolve(pemPath);
  if (!existsSync(abs)) throw new Error(`公钥文件不存在：${abs}`);
  const raw = readFileSync(abs, 'utf8');

  /* ① 拒收私钥：这是最要命的一种粘错 */
  if (/PRIVATE KEY/.test(raw)) {
    throw new Error('这个文件里含 PRIVATE KEY —— 你给的是**私钥**，拒绝入库。请提供公钥（.pub / -pubout 产物）');
  }
  if (!/BEGIN (RSA )?PUBLIC KEY/.test(raw)) {
    throw new Error('不像 PEM 公钥：缺少 `BEGIN PUBLIC KEY` 头。证书请先用 openssl 提取公钥');
  }

  /*
   * ② 先自检 base64 与 DER 长度。
   *
   * 为什么不直接 createPublicKey：它只会抛出
   * `error:1E08010C:DECODER routines::unsupported` —— 这句话对运维毫无信息量。
   * 而实际最常见的故障是"从聊天窗口复制 PEM，长行被重排、丢了几个字符"，
   * 那种情况下 base64 体长度不是 4 的倍数、DER 声明长度对不上，可以直接指出来。
   */
  const block = raw.match(/-----BEGIN ([^-]+)-----([\s\S]*?)-----END \1-----/);
  const body = block[2].replace(/\s+/g, '');
  if (body.length % 4 !== 0) {
    throw new Error(
      `PEM 的 base64 体长度是 ${body.length}，不是 4 的倍数 —— 多半是复制时丢了字符。\n` +
        '  请让对方发**文件**（.pem 附件 / zip），不要从聊天窗口里复制长文本；\n' +
        '  或让对方重新导出后把文件传过来。',
    );
  }

  const der = Buffer.from(body, 'base64');
  /* DER 头两个字节是 SEQUENCE 标签 + 长度；长度有两种编码，都要能读 */
  let declared;
  if (der[1] & 0x80) {
    const lenBytes = der[1] & 0x7f;
    let payload = 0;
    for (let i = 0; i < lenBytes; i += 1) payload = (payload << 8) | der[2 + i];
    declared = 2 + lenBytes + payload;
  } else {
    declared = 2 + der[1];
  }
  if (der.length !== declared) {
    throw new Error(
      `公钥内容不完整：DER 声明 ${declared} 字节，实际只有 ${der.length} 字节（缺 ${declared - der.length}）。\n` +
        '  同上，几乎都是复制丢了字符 —— 请让对方发文件。',
    );
  }

  /* ③ 能解析才算合法；④ 统一规范化成 SPKI，否则指纹与门户派生结果对不上 */
  let normalized;
  try {
    normalized = createPublicKey(raw).export({ format: 'pem', type: 'spki' }).toString();
  } catch (error) {
    throw new Error(`公钥无法解析：${error.message}`);
  }
  if (!normalized.includes('BEGIN PUBLIC KEY')) {
    throw new Error('规范化失败：结果不是 SPKI 公钥');
  }

  const fingerprint = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return { pem: normalized, fingerprint };
}

/* ────────────────────────── 数据库 ────────────────────────── */

async function connect() {
  const missing = ['DB_HOST', 'DB_USERNAME', 'DB_DATABASE'].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`缺少数据库环境变量：${missing.join(', ')}（确认在 portal/server 下执行，或 .env 存在）`);
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'p_service_key' LIMIT 1`,
  );
  if (rows.length === 0) {
    await conn.end();
    throw new Error('表 p_service_key 不存在：请先执行 npm run migration:run');
  }
  return conn;
}

const fingerprintOf = (pem) => createHash('sha256').update(pem).digest('hex').slice(0, 16);

/* ────────────────────────── 子命令 ────────────────────────── */

async function cmdRegister(flags) {
  const product = (flags.product ?? '').trim();
  const kid = (flags.kid ?? '').trim();
  if (!product) throw new Error('缺少 --product');
  if (!kid) throw new Error('缺少 --kid');
  if (!flags.pem) throw new Error('缺少 --pem（公钥文件路径）');

  if (!OWNER_PATTERN.test(product)) {
    throw new Error(`--product 不合法：${product}（小写字母开头，仅小写/数字/下划线，2-32 位）`);
  }
  const kidMatch = KID_PATTERN.exec(kid);
  if (!kidMatch) {
    throw new Error(`--kid 不符合规范：${kid}（要求 <product>-<yyyy-mm>，如 phone-2026-10）`);
  }
  if (kidMatch[1] !== product) {
    throw new Error(`--kid 前缀与 --product 不一致：${kid} vs ${product}`);
  }
  if (!KNOWN_PRODUCTS.includes(product) && !flags.force) {
    throw new Error(
      `--product=${product} 不在已知产品列表 ${KNOWN_PRODUCTS.join('/')} 里。` +
        '如果确实要新增一个产品，请加 --force',
    );
  }

  const { pem, fingerprint } = loadPublicKey(flags.pem);

  /* 指纹核对：对方在可信渠道（企微/工单）报来的指纹必须一致 */
  if (flags['expect-fingerprint']) {
    const expected = String(flags['expect-fingerprint']).trim().toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(expected)) {
      throw new Error(
        `--expect-fingerprint 要的是 16 位十六进制指纹（如 9bdae85b88e18945），你给的是 "${expected}"。\n` +
          '  指纹由对方用同一段 PEM 算出来报给你；如果暂时没有，就先不传这个参数，' +
          '脚本会把算出来的指纹打出来，你再拿去和对方核对。',
      );
    }
    if (expected !== fingerprint) {
      throw new Error(
        `指纹不一致，拒绝入库：\n  文件计算=${fingerprint}\n  期望值=${expected}\n` +
          '要么文件拿错了，要么传输过程被改过 —— 请与产品方重新核对',
      );
    }
  }

  const remarkParts = [];
  if (flags.who) remarkParts.push(`who=${flags.who}`);
  if (flags.ticket) remarkParts.push(`ticket=${flags.ticket}`);
  const remark = remarkParts.join(' ') || null;

  const params = [
    product,
    kid,
    pem,
    flags['not-before'] ? new Date(flags['not-before']) : null,
    flags['not-after'] ? new Date(flags['not-after']) : null,
    remark,
  ];

  if (flags['dry-run']) {
    console.log('[dry-run] 将执行：');
    console.log(
      'INSERT INTO p_service_key (owner_code, kid, public_key_pem, status, not_before, not_after, remark)\n' +
        'VALUES (?, ?, <PEM>, 0, ?, ?, ?)\n' +
        'ON DUPLICATE KEY UPDATE public_key_pem=VALUES(public_key_pem), status=0, ' +
        'not_before=VALUES(not_before), not_after=VALUES(not_after), remark=VALUES(remark)',
    );
    console.log('[dry-run] 参数：', params.slice(0, 2), '…', params.slice(3));
    console.log(`[dry-run] 指纹=${fingerprint}`);
    return 0;
  }

  const conn = await connect();
  try {
    const [existing] = await conn.query('SELECT kid, status FROM p_service_key WHERE kid = ?', [kid]);
    await conn.query(
      `INSERT INTO p_service_key (owner_code, kid, public_key_pem, status, not_before, not_after, remark)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         public_key_pem = VALUES(public_key_pem),
         status         = 0,
         not_before     = VALUES(not_before),
         not_after      = VALUES(not_after),
         remark         = VALUES(remark)`,
      params,
    );

    console.log(`✓ 已${existing.length > 0 ? '更新' : '登记'}公钥`);
    console.log(`  owner_code = ${product}`);
    console.log(`  kid        = ${kid}`);
    console.log(`  指纹       = ${fingerprint}`);
    if (existing.length > 0 && existing[0].status === 1) {
      console.log('  注意：这把公钥此前是停用状态，本次已重新启用（status=0）');
    }

    /* 轮换提醒：同产品还有哪些启用中的公钥 */
    const [others] = await conn.query(
      'SELECT kid FROM p_service_key WHERE owner_code = ? AND status = 0 AND kid <> ? ORDER BY created_at',
      [product, kid],
    );
    if (others.length > 0) {
      console.log('');
      console.log(`  ⚠ ${product} 还有 ${others.length} 把公钥处于启用状态：${others.map((r) => r.kid).join(', ')}`);
      console.log('    轮换场景下，确认旧 token 全部过期后应停用旧公钥：');
      for (const row of others) {
        console.log(`      node scripts/ops/register-service-key.cjs disable --kid ${row.kid}`);
      }
    }

    const interval = Number(process.env.SERVICE_KEY_RELOAD_INTERVAL_MS ?? 60_000);
    console.log('');
    console.log(`  生效：无需重启门户，最迟 ${Math.round(interval / 1000)} 秒内加载；`);
    console.log('        若对方已切到该 kid，首次请求会触发强刷，立即生效。');
  } finally {
    await conn.end();
  }
  return 0;
}

async function cmdList(flags) {
  const conn = await connect();
  try {
    const where = flags.product ? 'WHERE owner_code = ?' : '';
    const params = flags.product ? [flags.product] : [];
    const [rows] = await conn.query(
      `SELECT owner_code, kid, status, not_before, not_after, remark, created_at, public_key_pem
         FROM p_service_key ${where} ORDER BY owner_code, created_at`,
      params,
    );

    if (rows.length === 0) {
      console.log('（没有登记任何公钥）');
      return 0;
    }
    const fmt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '-');
    console.log(
      ['owner_code', 'kid', 'status', '指纹', 'not_after', 'remark'].join('\t'),
    );
    for (const r of rows) {
      console.log(
        [
          r.owner_code,
          r.kid,
          r.status === 0 ? '启用' : '停用',
          fingerprintOf(r.public_key_pem),
          fmt(r.not_after),
          r.remark ?? '-',
        ].join('\t'),
      );
    }
    console.log('');
    console.log(`共 ${rows.length} 条。指纹 = sha256(规范化 PEM) 前 16 位，与门户 kidFingerprint 同口径。`);
  } finally {
    await conn.end();
  }
  return 0;
}

async function cmdDisable(flags) {
  const kid = (flags.kid ?? '').trim();
  if (!kid) throw new Error('缺少 --kid');

  if (flags['dry-run']) {
    console.log(`[dry-run] 将执行：UPDATE p_service_key SET status = 1 WHERE kid = '${kid}'`);
    return 0;
  }

  const conn = await connect();
  try {
    const [result] = await conn.query('UPDATE p_service_key SET status = 1 WHERE kid = ?', [kid]);
    if (result.affectedRows === 0) {
      console.log(`没有找到 kid=${kid}，未改动任何行`);
      return 0;
    }
    const interval = Number(process.env.SERVICE_KEY_RELOAD_INTERVAL_MS ?? 60_000);
    console.log(`✓ 已停用 kid=${kid}`);
    console.log(`  生效：最迟 ${Math.round(interval / 1000)} 秒后该公钥不再被接受（不需要重启门户）。`);
    console.log('  提醒：停用只影响"用这把私钥签的凭据"，已签发的 token 仍受 exp（60s）约束。');
  } finally {
    await conn.end();
  }
  return 0;
}

/* ────────────────────────── 入口 ────────────────────────── */

(async () => {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') {
    usage();
    process.exit(command ? 0 : 1);
  }

  try {
    if (command === 'register') process.exit(await cmdRegister(flags));
    if (command === 'list') process.exit(await cmdList(flags));
    if (command === 'disable') process.exit(await cmdDisable(flags));
    console.error(`未知子命令：${command}`);
    usage();
    process.exit(1);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(error.message.includes('数据库') || error.message.includes('表 p_service_key') ? 2 : 1);
  }
})();
