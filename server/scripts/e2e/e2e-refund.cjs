/**
 * 开通失败 → 自动退款 路径验证（契约 §2.4 / §4.2）。
 *
 * 前置：
 *   1) 产品桩以故障模式启动：PROVISION_MODE=fail node scripts/stub-product-server.cjs
 *      （桩对任何 provision 都返回 code=4004 库存不足 = 业务失败，不重试）
 *   2) 门户服务在跑
 *   3) node scripts/e2e-refund.cjs
 *
 * 断言链条：下单 → 支付（扣费成功）→ worker 调 provision → 产品返回 4004
 *          → 门户自动退款 → 订单项 status=4 → 订单 status=3 → 钱包余额回到支付前
 *          → 流水里出现 type=3 退款且 refund_of_bill_no 指向原扣费单
 */
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 管理端鉴权：2026-10-10 起改为管理员账号（JWT），不再是静态 X-Admin-Key
const { loginAdmin } = require('../lib/admin-auth.cjs');

let passed = 0;
let failed = 0;
const failures = [];
/** 管理员 JWT：管理端接口用它鉴权（2026-10-10 起不再用静态 X-Admin-Key） */
let adminToken = '';

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
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
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: { __raw: text } };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitItemSettled(token, orderId, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await api(`/api/shop/orders/${orderId}`, { token });
    last = res.body?.data;
    const items = last?.items ?? [];
    // 4 已退款 或 3 失败待退款 都算"离开开通中"
    if (items.length > 0 && items.every((item) => item.status === 3 || item.status === 4)) return last;
    await sleep(700);
  }
  return last;
}

(async () => {
  const stamp = Date.now().toString().slice(-9);
  const username = `e2eref_${stamp}`;
  const password = 'Ab12345678';

  // 管理端鉴权前置：核销充值需要管理员 JWT（2026-10-10 起不再是 X-Admin-Key）
  {
    const admin = await loginAdmin(BASE);
    adminToken = admin.token;
    check('管理员登录成功（核销充值需要）', adminToken.length > 20, admin.username);
  }

  console.log(`\n=== 准备：注册 + 充值 100 元 ===`);
  let token = '';
  {
    const reg = await api('/api/auth/register', { method: 'POST', body: { username, password } });
    check('注册成功', reg.body.code === 0, reg.body);
    token = reg.body?.data?.access_token;

    const apply = await api('/api/wallet/recharge/apply', {
      method: 'POST',
      token,
      body: { amount_cents: 10000, remark: 'e2e 退款路径充值' },
    });
    await api(`/api/admin/recharges/${apply.body?.data?.apply_id}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: { reject: false },
    });
    const balance = await api('/api/wallet/balance', { token });
    check('充值到账 10000 分', balance.body?.data?.balance_cents === 10000, balance.body?.data);
  }

  console.log(`\n=== 1. 下单 + 支付（扣费应成功）===`);
  let orderId = '';
  {
    const created = await api('/api/shop/orders', {
      method: 'POST',
      token,
      body: { items: [{ product_code: 'storage', sku_id: 'storage-500g', quantity: 1 }] },
    });
    check('下单成功（3000 分）', created.body?.data?.total_cents === 3000, created.body?.data);
    orderId = created.body?.data?.order_id;

    const pay = await api(`/api/shop/orders/${orderId}/pay`, { method: 'POST', token });
    check('支付受理 code=0', pay.body.code === 0, pay.body);
    check('已受理项状态 1（开通中）', pay.body?.data?.items?.[0]?.status === 1, pay.body?.data?.items?.[0]);

    const balance = await api('/api/wallet/balance', { token });
    check('扣费已生效（10000 - 3000 = 7000）', balance.body?.data?.balance_cents === 7000, balance.body?.data);
  }

  console.log(`\n=== 2. 开通失败 → 自动退款 ===`);
  {
    const settled = await waitItemSettled(token, orderId);
    check('订单项最终状态为 4 已退款', settled?.items?.[0]?.status === 4, settled?.items?.[0]);
    check('fail_reason 记录了失败原因（4004）', String(settled?.items?.[0]?.fail_reason ?? '').includes('4004'), settled?.items?.[0]?.fail_reason);
    check('订单状态 = 3 全部失败', settled?.status === 3, settled?.status);

    // 退款流水关联（2026-10-10 新增，D 组 D-F3）：
    // 前端要从订单详情直接跳到"这笔退款在哪"，不必去流水页按金额时间人工翻
    const item = settled?.items?.[0];
    check(
      '**退款项带 refund_bill_no**（形如 refund:{item_id}:{attempt}）',
      /^refund:\d+:\d+$/.test(String(item?.refund_bill_no ?? '')),
      item?.refund_bill_no,
    );
    check('**退款项带 refunded_at**（到账时间，UTC ISO）', /^\d{4}-\d{2}-\d{2}T/.test(String(item?.refunded_at ?? '')), item?.refunded_at);
    check(
      'refund_bill_no 里的 item_id 与本项一致',
      String(item?.refund_bill_no ?? '').startsWith(`refund:${item?.item_id}:`),
      { refund_bill_no: item?.refund_bill_no, item_id: item?.item_id },
    );

    const balance = await api('/api/wallet/balance', { token });
    check('钱已退回（余额回到 10000）', balance.body?.data?.balance_cents === 10000, balance.body?.data);
  }

  console.log(`\n=== 3. 流水应包含扣费与退款两条 ===`);
  {
    const res = await api('/api/wallet/transactions?page=1&size=20', { token });
    const rows = res.body?.data?.list ?? [];
    const deduct = rows.find((row) => row.type === 2);
    const refund = rows.find((row) => row.type === 3);

    check('存在扣费流水（type=2）', Boolean(deduct), rows.map((r) => r.type));
    check(
      '扣费 bill_no = order:{order_id}:item:{item_id}（契约 §2.4）',
      new RegExp(`^order:${orderId}:item:\\d+$`).test(String(deduct?.bill_no ?? '')),
      deduct?.bill_no,
    );
    check('存在退款流水（type=3）', Boolean(refund), rows.map((r) => r.type));
    check('退款流水 refund_of_bill_no 指向原扣费单', refund?.refund_of_bill_no === deduct?.bill_no, {
      refund_of: refund?.refund_of_bill_no,
      deduct: deduct?.bill_no,
    });
    check('退款金额等于扣费金额', refund?.amount_cents === deduct?.amount_cents, {
      refund: refund?.amount_cents,
      deduct: deduct?.amount_cents,
    });
    check('退款 bill_no 形如 refund:{item_id}:{attempt}', /^refund:\d+:\d+$/.test(String(refund?.bill_no ?? '')), refund?.bill_no);
  }

  console.log(`\n=== 4. 退款幂等：不会重复退 ===`);
  {
    const before = (await api('/api/wallet/balance', { token })).body?.data?.balance_cents;
    // 等 worker 再跑几轮，确认不会因为重试再退一次
    await sleep(6000);
    const after = (await api('/api/wallet/balance', { token })).body?.data?.balance_cents;
    check('等待若干轮后余额不变（无重复退款）', before === after, { before, after });

    const rows = (await api('/api/wallet/transactions?type=3', { token })).body?.data?.list ?? [];
    check('退款流水只有一条', rows.length === 1, rows.length);
  }

  console.log(`\n=== 5. 失败订单不可再支付（4002）===`);
  {
    const pay = await api(`/api/shop/orders/${orderId}/pay`, { method: 'POST', token });
    check('已全部失败的订单再支付 -> 4002', pay.body.code === 4002, pay.body);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length > 0) {
    console.log('\n失败明细：');
    failures.forEach((item) => console.log(`  - ${item}`));
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n脚本异常：', error);
  process.exit(2);
});
