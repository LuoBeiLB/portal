/**
 * 门户后端接口自验脚本 —— 一条命令走完全部对外接口。
 *
 * 用法（在 portal/server 目录下）：
 *   node scripts/verify-api.cjs                                  # 验本地 127.0.0.1:3000
 *   node scripts/verify-api.cjs http://x.x.x.x:3000              # 验远端
 *   node scripts/verify-api.cjs http://x.x.x.x:3000 admin <密码>  # 指定管理员账号（默认取 .env）
 *
 * 环境变量可覆盖：
 *   ADMIN_USERNAME / ADMIN_PASSWORD  管理员账号（2026-10-10 起管理端用账号登录，
 *                                    不再是 X-Admin-Key；默认取 .env，启动时由环境变量 bootstrap）
 *   INTERNAL_KEY   内网 X-Internal-Key（默认取 .env 的 STUB_PRODUCT_INTERNAL_KEY）
 *                  ⚠️ 若你要验的是**真实云存储**，请显式传 PRODUCT_STORAGE_INTERNAL_KEY 的值：
 *                     INTERNAL_KEY=<真实密钥> node scripts/verify-api.cjs <地址>
 *
 * 它做什么：按契约逐条调接口，并把「HTTP 状态码 / 业务 code / 关键字段类型」打印出来。
 * 目的不是断言全通过，而是让你一眼看出**哪个接口、哪一步、返回了什么**。
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const INTERNAL_KEY = process.env.INTERNAL_KEY || process.env.STUB_PRODUCT_INTERNAL_KEY || '';
const { loginAdmin, ADMIN_USERNAME: adminUser } = require('../lib/admin-auth.cjs');

let pass = 0;
let fail = 0;
const rows = [];

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

async function call(method, path, { body, token, headers = {}, raw = false } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { http: response.status, code: json?.code, message: json?.message, data: json?.data, text, raw };
}

function record(label, result, expectation, note) {
  const expOk = typeof expectation === 'function' ? expectation(result) : result.code === expectation;
  if (expOk) pass += 1;
  else fail += 1;
  const shown = result.raw ? `${String(result.text).slice(0, 40)}…` : `code=${result.code}`;
  rows.push({
    ok: expOk,
    label,
    http: result.http,
    shown,
    note: note ?? (result.raw ? '' : String(result.message ?? '').slice(0, 30)),
  });
}

(async () => {
  console.log(`\n目标：${BASE}\n`);

  const stamp = Date.now().toString().slice(-9);
  const username = `verify_${stamp}`;
  const password = 'Ab12345678';
  let token = '';
  let userId = '';
  let orderId = '';

  // ---------- 1. 探活（无需认证） ----------
  console.log('── 1. 探活与元信息 ──');
  const health = await call('GET', '/api/healthz');
  record('GET  /api/healthz', health, 0, `status=${health.data?.status} db=${health.data?.database}`);

  const meta = await call('GET', '/api/meta');
  record('GET  /api/meta', meta, 0, `contract=${meta.data?.contract}`);

  const jwks = await call('GET', '/.well-known/jwks.json', { raw: true });
  record('GET  /.well-known/jwks.json（裸响应，不套壳）', jwks, (r) => r.http === 200 && r.text.includes('"keys"'), 'JWKS 公钥集');

  // ---------- 2. 认证 ----------
  console.log('── 2. 认证 ──');
  const reg = await call('POST', '/api/auth/register', { body: { username, password } });
  token = reg.data?.access_token ?? '';
  userId = reg.data?.id ?? '';
  record('POST /api/auth/register', reg, 0, `user.id 类型=${typeOf(reg.data?.id)}（应为 string）`);

  const login = await call('POST', '/api/auth/login', { body: { username, password } });
  record('POST /api/auth/login', login, 0, `expires_in=${login.data?.expires_in}`);

  const badLogin = await call('POST', '/api/auth/login', { body: { username, password: 'wrong-password' } });
  record('POST /api/auth/login（错密码）', badLogin, 2003, '应返回 2003');

  const noAuth = await call('GET', '/api/wallet/balance');
  record('GET  /api/wallet/balance（无 token）', noAuth, 1002, '应返回 1002');

  const badAuth = await call('GET', '/api/wallet/balance', { token: 'not.a.jwt' });
  record('GET  /api/wallet/balance（乱写 token）', badAuth, 1002, '应返回 1002');

  // ---------- 3. 钱包 ----------
  console.log('── 3. 钱包 ──');
  const balance = await call('GET', '/api/wallet/balance', { token });
  record('GET  /api/wallet/balance', balance, 0, `balance_cents 类型=${typeOf(balance.data?.balance_cents)}（应为 number）`);

  const txn = await call('GET', '/api/wallet/transactions?page=1&size=5', { token });
  record('GET  /api/wallet/transactions', txn, 0, `total 类型=${typeOf(txn.data?.total)}（应为 number）`);

  const apply = await call('POST', '/api/wallet/recharge/apply', {
    token,
    body: { amount_cents: 10000, remark: 'verify-api 自验' },
  });
  const applyId = apply.data?.apply_id;
  record('POST /api/wallet/recharge/apply', apply, 0, `apply_id 类型=${typeOf(applyId)}（应为 string）`);

  const badAmount = await call('POST', '/api/wallet/recharge/apply', { token, body: { amount_cents: 99 } });
  record('POST /api/wallet/recharge/apply（99 分，低于下限）', badAmount, 1001, '应返回 1001');

  // ---------- 4. 管理端 ----------
  {
    console.log('── 4. 管理端（管理员账号，Bearer JWT） ──');

    const adminNoToken = await call('GET', '/api/admin/recharges');
    record('GET  /api/admin/recharges（未登录）', adminNoToken, 1002, '应返回 1002');

    const adminAsUser = await call('GET', '/api/admin/recharges', { token });
    record('GET  /api/admin/recharges（普通用户）', adminAsUser, 1004, '应返回 1004');

    let adminToken = '';
    try {
      adminToken = (await loginAdmin(BASE)).token;
      record('POST /api/auth/login（管理员登录）', { http: 200, code: 0 }, 0, `账号 ${adminUser}`);
    } catch (error) {
      record('管理员登录', { http: 0, code: -1, text: String(error.message) }, 0, '检查 .env 的 ADMIN_USERNAME / ADMIN_PASSWORD');
    }

    if (adminToken) {
      const auth = { authorization: `Bearer ${adminToken}` };

      const verify = await call('GET', '/api/admin/auth/verify', { headers: auth });
      record('GET  /api/admin/auth/verify', verify, 0, `operator=${verify.data?.operator} role=${verify.data?.role}`);

      const admin = await call('GET', '/api/admin/recharges?page=1&size=5', { headers: auth });
      record('GET  /api/admin/recharges', admin, 0, `total=${admin.data?.total}`);

      const confirm = await call('POST', `/api/admin/recharges/${applyId}/confirm`, {
        headers: auth,
        body: { reject: false },
      });
      record('POST /api/admin/recharges/{id}/confirm（核销到账）', confirm, 0, `balance_cents=${confirm.data?.balance_cents}`);

      const confirmAgain = await call('POST', `/api/admin/recharges/${applyId}/confirm`, {
        headers: auth,
        body: { reject: false },
      });
      record('POST /api/admin/recharges/{id}/confirm（重复核销）', confirmAgain, 1001, '应返回 1001');

      const users = await call('GET', '/api/admin/users?page=1&size=5', { headers: auth });
      record('GET  /api/admin/users', users, 0, `total=${users.data?.total}`);

      const txns = await call('GET', '/api/admin/transactions?page=1&size=5', { headers: auth });
      record('GET  /api/admin/transactions', txns, 0, `total=${txns.data?.total}`);

      const logs = await call('GET', '/api/admin/audit-logs?page=1&size=5', { headers: auth });
      record('GET  /api/admin/audit-logs', logs, 0, `total=${logs.data?.total}`);

      const admins = await call('GET', '/api/admin/admins', { headers: auth });
      record('GET  /api/admin/admins', admins, 0, `total=${admins.data?.total}`);

      const daily = await call('GET', '/api/admin/reconciliation/daily', { headers: auth });
      record('GET  /api/admin/reconciliation/daily', daily, 0, '');

      const jobs = await call('GET', '/api/admin/reconciliation/provision-jobs', { headers: auth });
      record('GET  /api/admin/reconciliation/provision-jobs', jobs, 0, `stats=${JSON.stringify(jobs.data?.stats)}`);

      const csv = await call('GET', '/api/admin/transactions/export', { headers: auth, raw: true });
      record('GET  /api/admin/transactions/export（裸 CSV）', csv, (r) => r.http === 200 && !r.text.includes('"code"'), 'CSV，不套壳');
    }
  }

  // ---------- 5. 商城 ----------
  console.log('── 5. 商城 ──');
  const products = await call('GET', '/api/shop/products', { token });
  const productList = products.data?.list ?? [];
  record('GET  /api/shop/products', products, 0, `商品数=${productList.length}`);

  if (productList.length > 0) {
    const sku = productList[0];
    const order = await call('POST', '/api/shop/orders', {
      token,
      body: { items: [{ product_code: sku.product_code, sku_id: sku.sku_id, quantity: 1 }] },
    });
    orderId = order.data?.order_id;
    record('POST /api/shop/orders', order, 0, `order_id 类型=${typeOf(orderId)}（应为 string）`);

    const detail = await call('GET', `/api/shop/orders/${orderId}`, { token });
    record('GET  /api/shop/orders/{id}', detail, 0, `status=${detail.data?.status}`);

    const list = await call('GET', '/api/shop/orders?page=1&size=5', { token });
    record('GET  /api/shop/orders', list, 0, `total=${list.data?.total}`);

    const pay = await call('POST', `/api/shop/orders/${orderId}/pay`, { token });
    record(
      'POST /api/shop/orders/{id}/pay',
      pay,
      (r) => r.code === 0 || r.code === 3001,
      `accepted=${pay.data?.accepted_items} processing=${pay.data?.processing_items}（3001=余额不足，正常）`,
    );

    const notFound = await call('GET', '/api/shop/orders/999999999', { token });
    record('GET  /api/shop/orders/999999999（不存在）', notFound, 4001, '应返回 4001');
  } else {
    console.log('  ⚠ 商品列表为空 —— 说明门户还没从产品拉到商品。');
    console.log('    检查：产品服务是否在跑？.env 的 PRODUCT_STORAGE_BASE_URL 是否指向它？');
    console.log('    看门户日志有没有「商品同步完成」或「商品同步失败」。');
  }

  // ---------- 6. 内网（产品侧调用，前端/管理端不该用） ----------
  if (INTERNAL_KEY) {
    console.log('── 6. 内网接口（X-Internal-Key） ──');
    const noKey = await call('POST', '/api/wallet/deduct', {
      body: { portal_user_id: userId, product_code: 'storage', bill_no: `verify-${stamp}-a`, amount_cents: 100 },
    });
    record('POST /api/wallet/deduct（不带 key）', noKey, 1002, '应返回 1002');

    const deduct = await call('POST', '/api/wallet/deduct', {
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: userId, product_code: 'storage', bill_no: `verify-${stamp}-b`, amount_cents: 100 },
    });
    record('POST /api/wallet/deduct（带 key）', deduct, 0, `balance_after=${deduct.data?.balance_after}`);

    const repeat = await call('POST', '/api/wallet/deduct', {
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: userId, product_code: 'storage', bill_no: `verify-${stamp}-b`, amount_cents: 100 },
    });
    record('POST /api/wallet/deduct（同 bill_no 重复）', repeat, 3003, '应返回 3003 幂等');

    const refund = await call('POST', '/api/wallet/refund', {
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: {
        bill_no: `verify-${stamp}-b`,
        refund_bill_no: `verify-${stamp}-r1`,
        amount_cents: 100,
        reason: 'verify-api 自验退款',
      },
    });
    record('POST /api/wallet/refund', refund, 0, '应返回 0');
  } else {
    console.log('── 6. 内网接口：跳过（未提供 INTERNAL_KEY）──');
  }

  // ---------- 输出 ----------
  console.log('\n' + '='.repeat(100));
  console.log('结果明细');
  console.log('='.repeat(100));
  console.log(`${'  '.padEnd(2)}${'接口'.padEnd(52)}${'HTTP'.padEnd(7)}${'结果'.padEnd(16)}备注`);
  console.log('-'.repeat(100));
  for (const row of rows) {
    console.log(
      `${row.ok ? ' ✓' : ' ✗'} ${row.label.padEnd(52)}${String(row.http).padEnd(7)}${row.shown.padEnd(16)}${row.note}`,
    );
  }
  console.log('-'.repeat(100));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);

  const failures = rows.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.log('\n失败项（重点看这些）：');
    for (const f of failures) console.log(`  ✗ ${f.label} → HTTP ${f.http} ${f.shown}`);
  }
  console.log('\n提示：HTTP 非 200 只可能是 404（路由不存在）或框架层错误；业务失败也是 200 + code。\n');
})().catch((error) => {
  console.error(`\n请求失败：${error.message}`);
  console.error('\n可能原因：');
  console.error('  1. 服务没起（先确认 /api/healthz 能访问）');
  console.error('  2. 地址或端口不对');
  console.error('  3. Redis 没起 → 注册/登录会失败（其余接口仍可访问）');
  process.exit(1);
});
