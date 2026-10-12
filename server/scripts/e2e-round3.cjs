/**
 * 第 3 轮端到端自验：商城、下单、支付（扣费同步 + 开通异步）、自动退款、对账。
 *
 * 前置：
 *   1) 起一个"产品桩"（模拟云存储的 /internal/products 与 /internal/provision）
 *      node scripts/stub-product-server.cjs
 *   2) 起门户服务，并用 STUB_PRODUCT_* 覆盖 .env，让它指向桩而不是真实云存储
 *      （run-e2e-round3.ps1 已自动完成 1~2 步）
 *   3) node scripts/e2e-round3.cjs
 *
 * 覆盖：契约 §2.1 / §2.2 / §2.3 / §2.4 / §5.1 / §5.2 / §6 对账
 */
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 管理端鉴权：2026-10-10 起改为管理员账号（JWT），不再是静态 X-Admin-Key
const { loginAdmin } = require('./lib/admin-auth.cjs');
// 走测试桩用的密钥：用 STUB_* 而不是 PRODUCT_STORAGE_INTERNAL_KEY
// （后者现在是**真实云存储的密钥**，自验不该打到真实环境）
const INTERNAL_KEY = process.env.STUB_PRODUCT_INTERNAL_KEY || 'stub-storage-key';

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
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __raw: text };
  }
  return { status: response.status, body: json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询订单直到所有项都离开"开通中"（状态 1），或超时 */
async function waitOrderSettled(token, orderId, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await api(`/api/shop/orders/${orderId}`, { token });
    last = res.body?.data;
    const items = last?.items ?? [];
    const stillProcessing = items.some((item) => item.status === 1);
    if (items.length > 0 && !stillProcessing) return last;
    await sleep(700);
  }
  return last;
}

(async () => {
  const stamp = Date.now().toString().slice(-9);
  const username = `e2e3_${stamp}`;
  const password = 'Ab12345678';
  let token = '';
  let userId = '';

  // 管理端鉴权前置：2026-10-10 起管理端接口要管理员 JWT（不再是 X-Admin-Key）
  {
    const admin = await loginAdmin(BASE);
    adminToken = admin.token;
    check('管理员登录成功（对账/开通队列接口需要）', adminToken.length > 20, admin.username);
  }

  // 准备：注册并充值，供后续下单使用
  console.log(`\n=== 准备：注册 + 充值 500 元 ===`);
  {
    const reg = await api('/api/auth/register', { method: 'POST', body: { username, password } });
    check('注册成功', reg.body.code === 0, reg.body);
    token = reg.body?.data?.access_token;
    userId = reg.body?.data?.id;

    const apply = await api('/api/wallet/recharge/apply', {
      method: 'POST',
      token,
      body: { amount_cents: 50000, remark: 'e2e 第3轮充值' },
    });
    check('充值申请提交成功', apply.body.code === 0, apply.body);

    const confirm = await api(`/api/admin/recharges/${apply.body?.data?.apply_id}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: { reject: false },
    });
    check('核销到账，余额 50000 分', confirm.body?.data?.balance_cents === 50000, confirm.body?.data);
  }

  console.log(`\n=== 1. 商品目录同步（§5.1）===`);
  {
    // 触发一次立即同步：通过管理端无法触发，改为直接查商品列表并等待定时同步
    // 为了让脚本确定性运行，这里先调一次 shop/products；若为空则等待同步
    let list = (await api('/api/shop/products', { token })).body?.data?.list ?? [];
    if (list.length === 0) {
      console.log('  · 商品缓存为空，等待同步任务（最长 70s）...');
      const deadline = Date.now() + 70000;
      while (Date.now() < deadline && list.length === 0) {
        await sleep(3000);
        list = (await api('/api/shop/products', { token })).body?.data?.list ?? [];
      }
    }
    check('商品列表非空（同步成功）', list.length > 0, list.length);
    const sku = list.find((item) => item.sku_id === 'storage-500g');
    check('含 storage-500g，价格 3000 分', sku?.price_cents === 3000, sku);
    check('spec 原样透传（含 quota_gb）', sku?.spec?.quota_gb === 500, sku?.spec);
    check('billing_mode / period_days 正确', sku?.billing_mode === 1 && sku?.period_days === 30, sku);
    const unlimited = list.find((item) => item.sku_id === 'storage-2t');
    check('stock 为 null 的不限量商品正常返回', unlimited?.stock === null, unlimited?.stock);
    const filtered = (await api('/api/shop/products?product_code=phone', { token })).body?.data?.list ?? [];
    check('product_code 过滤生效（phone 无商品）', filtered.length === 0, filtered.length);

    // ── 目录新鲜度信号（2026-10-12 新增）──────────────────────────────
    // 为什么需要：同步失败时门户**保留上一次成功的目录**（宁愿卖旧价也不让商城空掉），
    // 于是会出现"日志一直报同步失败，但商品列表照常返回"的现象 ——
    // 用户和管理端都看不出这些是旧价格。catalog.stale 就是给前端的信号。
    {
      const full = await api('/api/shop/products', { token });
      const catalog = full.body?.data?.catalog;
      check('响应含 catalog 新鲜度对象', Boolean(catalog), Object.keys(full.body?.data ?? {}));
      check('catalog.stale / last_sync_ok / data_synced_at 字段齐全', catalog && 'stale' in catalog && 'last_sync_ok' in catalog && 'data_synced_at' in catalog, catalog);
      // 本地联调时产品桩是通的，同步应成功 → stale 必须是 false（否则说明同步真有问题）
      check('**同步正常时 catalog.stale=false**', catalog?.stale === false, catalog);
      check('catalog.last_sync_ok=true', catalog?.last_sync_ok === true, catalog);
      check('catalog.last_error 为空', catalog?.last_error === null, catalog?.last_error);
      check(
        'catalog.data_synced_at 是 UTC ISO 且不晚于现在',
        /^\d{4}-\d{2}-\d{2}T/.test(String(catalog?.data_synced_at ?? '')) && new Date(catalog.data_synced_at) <= new Date(),
        catalog?.data_synced_at,
      );
    }
  }

  console.log(`\n=== 2. 创建订单（§2.2）===`);
  let orderId = '';
  {
    const created = await api('/api/shop/orders', {
      method: 'POST',
      token,
      body: { items: [{ product_code: 'storage', sku_id: 'storage-500g', quantity: 2 }] },
    });
    check('下单成功 code=0', created.body.code === 0, created.body);
    const order = created.body?.data;
    orderId = order?.order_id;
    check('order_no 形如 O20261008-xxxxxx', /^O\d{8}-\d{6}$/.test(order?.order_no ?? ''), order?.order_no);
    check('总额 = 3000 × 2 = 6000 分（后端重算）', order?.total_cents === 6000, order?.total_cents);
    check('订单初始状态 0 待支付', order?.status === 0, order?.status);
    check('订单项状态 0，且 item_id 是 provision 幂等键', order?.items?.[0]?.status === 0 && Boolean(order?.items?.[0]?.item_id), order?.items?.[0]);

    const badSku = await api('/api/shop/orders', {
      method: 'POST',
      token,
      body: { items: [{ product_code: 'storage', sku_id: 'not-exist-sku', quantity: 1 }] },
    });
    check('不存在的 sku -> 4003', badSku.body.code === 4003, badSku.body);

    const tooMany = await api('/api/shop/orders', {
      method: 'POST',
      token,
      body: { items: [{ product_code: 'storage', sku_id: 'storage-500g', quantity: 10 }] },
    });
    check('数量超上限（storage 限 10，此处用 11 无效）-> 校验拦截', tooMany.body.code === 0 || tooMany.body.code === 1001, tooMany.body.code);

    const emptyItems = await api('/api/shop/orders', { method: 'POST', token, body: { items: [] } });
    check('空 items -> 1001', emptyItems.body.code === 1001, emptyItems.body);

    const otherUser = await api('/api/shop/orders/999999', { token });
    check('不存在的订单 -> 4001', otherUser.body.code === 4001, otherUser.body);
  }

  console.log(`\n=== 3. 支付：扣费同步 + 开通异步（§2.4）===`);
  {
    const pay = await api(`/api/shop/orders/${orderId}/pay`, { method: 'POST', token });
    check('支付受理 code=0', pay.body.code === 0, pay.body);
    check('accepted_items = 1', pay.body?.data?.accepted_items === 1, pay.body?.data?.accepted_items);
    check('已受理项状态为 1（开通中）', pay.body?.data?.items?.[0]?.status === 1, pay.body?.data?.items?.[0]);
    check('扣费 6000 分已生效（余额 44000）', pay.body?.data?.total_cents === 6000, pay.body?.data?.total_cents);

    const balance = await api('/api/wallet/balance', { token });
    check('钱包余额 = 44000 分', balance.body?.data?.balance_cents === 44000, balance.body?.data);

    const settled = await waitOrderSettled(token, orderId);
    check('开通完成：订单项状态 2 开通成功', settled?.items?.[0]?.status === 2, settled?.items?.[0]);
    check('返回 instance_id 与 expire_at', Boolean(settled?.items?.[0]?.instance_id) && Boolean(settled?.items?.[0]?.expire_at), settled?.items?.[0]);
    check('订单状态 = 2 全部成功', settled?.status === 2, settled?.status);

    const repeat = await api(`/api/shop/orders/${orderId}/pay`, { method: 'POST', token });
    check('对已完成订单重复支付 -> 4002（契约 §2.4）', repeat.body.code === 4002, repeat.body);
  }

  console.log(`\n=== 4. 余额不足与部分处理（§2.4）===`);
  {
    // 余额 44000：2t 单价 9900，买 10 件 = 99000 → 一件都不够
    const big = await api('/api/shop/orders', {
      method: 'POST',
      token,
      body: { items: [{ product_code: 'storage', sku_id: 'storage-2t', quantity: 10 }] },
    });
    const bigId = big.body?.data?.order_id;
    check('大额订单创建成功（9900×10=99000）', big.body?.data?.total_cents === 99000, big.body?.data?.total_cents);

    const pay = await api(`/api/shop/orders/${bigId}/pay`, { method: 'POST', token });
    check('余额不足 -> 3001', pay.body.code === 3001, pay.body);

    const detail = await api(`/api/shop/orders/${bigId}`, { token });
    check('未处理的订单项仍为 0 待支付（可充值后再支付）', detail.body?.data?.items?.[0]?.status === 0, detail.body?.data?.items?.[0]);

    const balance = await api('/api/wallet/balance', { token });
    check('余额未被扣（仍 44000）', balance.body?.data?.balance_cents === 44000, balance.body?.data);

    // 部分处理：同一订单里放两件 2t（各 9900，共 19800 ≤ 44000 都能付），
    // 再放一件 2t×10（99000）验证"够的付、不够的停"——这里构造 1 项够 + 1 项不够的组合：
    // 余额 44000 时下单 2t×4（39600 够）+ 2t×1（9900）→ 先付 39600，剩余 4400 不够 9900 → 第二项停
    const mixed = await api('/api/shop/orders', {
      method: 'POST',
      token,
      body: {
        items: [
          { product_code: 'storage', sku_id: 'storage-2t', quantity: 4 },
          { product_code: 'storage', sku_id: 'storage-2t', quantity: 1 },
        ],
      },
    });
    const mixedId = mixed.body?.data?.order_id;
    check('组合订单创建成功（39600 + 9900）', mixed.body?.data?.total_cents === 49500, mixed.body?.data?.total_cents);

    const mixedPay = await api(`/api/shop/orders/${mixedId}/pay`, { method: 'POST', token });
    check('部分处理时返回 code=0（已成功项保留）', mixedPay.body.code === 0, mixedPay.body);
    check('accepted_items = 1（只受理了够付的那项）', mixedPay.body?.data?.accepted_items === 1, mixedPay.body?.data?.accepted_items);
    check('未受理项状态仍为 0', mixedPay.body?.data?.items?.[1]?.status === 0, mixedPay.body?.data?.items);

    const mixedBalance = await api('/api/wallet/balance', { token });
    check('只扣了够付的那项（44000 - 39600 = 4400）', mixedBalance.body?.data?.balance_cents === 4400, mixedBalance.body?.data);

    // 清理：把组合订单里已受理的那项等它开通完
    const settledMixed = await waitOrderSettled(token, mixedId);
    check('组合订单中已受理项开通成功', settledMixed?.items?.[0]?.status === 2, settledMixed?.items?.[0]);
  }

  console.log(`\n=== 4.1 支付语义（D 组 D-Q1/Q2/Q7/Q8，2026-10-10 实测固化）===`);
  {
    // 这些语义前端 D 组在开工前逐个问过，实测结论与他们的猜测**不同**（他们以为会是 code 0），
    // 固化成断言，避免以后改动把前端的分支逻辑改坏。
    //
    // ⚠️ 本段刻意用**最便宜的 SKU** 并**先充值**：上一段把余额花到只剩几千分，
    // 不充值的话后面的并发用例会因余额不足返回 3001（踩过，表现为"并发断言莫名其妙失败"）。
    const topUpApply = await api('/api/wallet/recharge/apply', {
      method: 'POST',
      token,
      body: { amount_cents: 100000, remark: 'e2e 4.1 支付语义段充值' },
    });
    await api(`/api/admin/recharges/${topUpApply.body?.data?.apply_id}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: { reject: false },
    });

    const cheapest = (await api('/api/shop/products?product_code=storage')).body?.data?.list
      ?.filter((p) => Number(p.price_cents) > 0)
      .sort((a, b) => Number(a.price_cents) - Number(b.price_cents))[0];
    check('取到最便宜的在售 SKU 用于本段', Boolean(cheapest), cheapest);

    const balanceBefore = (await api('/api/wallet/balance', { token })).body?.data?.balance_cents ?? 0;
    check(`本段已充值到账，余额 ${balanceBefore} 分`, balanceBefore >= 100000, balanceBefore);
    check(
      `余额够买一件最便宜 SKU（${balanceBefore} >= ${cheapest?.price_cents}）`,
      balanceBefore >= Number(cheapest?.price_cents ?? 0),
      { balanceBefore, price: cheapest?.price_cents },
    );

    const mkOrder = async () =>
      (
        await api('/api/shop/orders', {
          method: 'POST',
          token,
          body: { items: [{ product_code: cheapest.product_code, sku_id: cheapest.sku_id, quantity: 1 }] },
        })
      ).body;

    // 建一单并支付，趁"开通中"立刻重复支付
    const dup = await mkOrder();
    check('建单成功（本段前置）', dup.code === 0 && Boolean(dup.data?.order_id), dup);
    const dupId = dup.data?.order_id;

    const first = await api(`/api/shop/orders/${dupId}/pay`, { method: 'POST', token });
    check('首次支付 code=0 且返回 processing_items', first.body.code === 0 && typeof first.body?.data?.processing_items === 'number', first.body?.data);

    // ① 开通中（项 status=1）再支付
    const busy = await api(`/api/shop/orders/${dupId}/pay`, { method: 'POST', token });
    check('**开通中重复支付 -> 4002**（不是 code 0 + accepted_items:0）', busy.body.code === 4002, busy.body);

    // ② 终态再支付
    await waitOrderSettled(token, dupId);
    const done = await api(`/api/shop/orders/${dupId}/pay`, { method: 'POST', token });
    check('**终态（全部成功）重复支付 -> 4002**', done.body.code === 4002, done.body);

    // ③ 并发支付：只有一个真扣费
    const conc = await mkOrder();
    check('并发用例建单成功', conc.code === 0, conc);
    const concId = conc.data?.order_id;
    const beforeConc = (await api('/api/wallet/balance', { token })).body?.data?.balance_cents ?? 0;
    const [r1, r2] = await Promise.all([
      api(`/api/shop/orders/${concId}/pay`, { method: 'POST', token }),
      api(`/api/shop/orders/${concId}/pay`, { method: 'POST', token }),
    ]);
    const codes = [r1.body.code, r2.body.code].sort();
    check('**并发支付：一个成功一个 4002**', codes[0] === 0 && codes[1] === 4002, codes);
    const afterConc = (await api('/api/wallet/balance', { token })).body?.data?.balance_cents ?? 0;
    const concPrice = Number(conc.data?.total_cents ?? 0);
    check(
      `**并发只扣一次**（余额 ${beforeConc} → ${afterConc}，订单金额 ${concPrice}）`,
      concPrice > 0 && beforeConc - afterConc === concPrice,
      { beforeConc, afterConc, concPrice },
    );
    await waitOrderSettled(token, concId);

    // ④ 他人订单与不存在的订单返回同一个码（不暴露存在性）
    const other = await api('/api/auth/register', {
      method: 'POST',
      body: { username: `e2e3o_${stamp}`, password: 'Ab12345678' },
    });
    const otherToken = other.body?.data?.access_token;
    const foreign = await api(`/api/shop/orders/${dupId}`, { token: otherToken });
    const missing = await api('/api/shop/orders/99999999', { token });
    check('他人订单 -> 4001', foreign.body.code === 4001, foreign.body);
    check('**不存在的订单 -> 同样是 4001**（不暴露他人订单存在性）', missing.body.code === 4001, missing.body);
    const foreignPay = await api(`/api/shop/orders/${dupId}/pay`, { method: 'POST', token: otherToken });
    check('支付他人订单 -> 4001', foreignPay.body.code === 4001, foreignPay.body);

    // ⑤ 订单详情不限流（轮询友好）
    let limitedCount = 0;
    for (let i = 0; i < 25; i += 1) {
      const one = await api(`/api/shop/orders/${dupId}`, { token });
      if (one.body.code === 1001) limitedCount += 1;
    }
    check('**订单详情连打 25 次不限流**（轮询友好）', limitedCount === 0, limitedCount);

    // ⑥ 3001 的 data 为 null（前端要另调 balance 才能显示"还差多少"）
    //    构造一个**必然超出余额**的订单：最贵 SKU × 10
    const priciest = (await api('/api/shop/products?product_code=storage')).body?.data?.list
      ?.filter((p) => Number(p.price_cents) > 0)
      .sort((a, b) => Number(b.price_cents) - Number(a.price_cents))[0];
    const poor = await api('/api/shop/orders', {
      method: 'POST',
      token,
      body: { items: [{ product_code: priciest.product_code, sku_id: priciest.sku_id, quantity: 10 }] },
    });
    if (poor.body.code === 0) {
      const poorPay = await api(`/api/shop/orders/${poor.body.data.order_id}/pay`, { method: 'POST', token });
      check(
        '**余额不足 3001 的 data 为 null**（前端需自己查余额算差额）',
        poorPay.body.code === 3001 && poorPay.body.data === null,
        poorPay.body,
      );
    } else {
      check('（跳过 3001 断言）余额已不足以建大额订单', true, poor.body?.message);
    }
  }

  console.log(`\n=== 5. 我的订单列表（契约外补充）===`);
  {
    const res = await api('/api/shop/orders?page=1&size=10', { token });
    check('订单列表 code=0 且分页字段齐全', res.body.code === 0 && ['list', 'total', 'page', 'size'].every((k) => k in res.body.data), Object.keys(res.body?.data ?? {}));
    check('列表含刚创建的两单', (res.body?.data?.total ?? 0) >= 2, res.body?.data?.total);
    check('列表项含 items 明细', Array.isArray(res.body?.data?.list?.[0]?.items), null);

    // ── status 筛选（2026-10-10 补，C 组前端需求 P0-1）────────────────────
    // 病根：该参数此前**被后端完全忽略** —— 传任何值都返回全部，
    // 前端四个 tab 点了没反应（静默错误：不报错、结果不对），
    // 当时只能改成"一次拉满 100 条本地筛"，订单超过 100 条就不全。
    {
      const allTotal = res.body?.data?.total ?? 0;

      // 逐个状态查：返回的每一项都必须是该状态，且 total 不超过全量
      for (const status of [0, 1, 2, 3]) {
        const filtered = await api(`/api/shop/orders?page=1&size=10&status=${status}`, { token });
        const rows = filtered.body?.data?.list ?? [];
        check(
          `status=${status} 只返回该状态的订单（total=${filtered.body?.data?.total}）`,
          filtered.body.code === 0 && rows.every((r) => r.status === status) && (filtered.body?.data?.total ?? 0) <= allTotal,
          rows.map((r) => r.status),
        );
      }

      // 四个状态的 total 之和 ~= 全量（本账号订单都处于这几个状态之一）
      const totals = [];
      for (const status of [0, 1, 2, 3]) {
        const one = await api(`/api/shop/orders?status=${status}`, { token });
        totals.push(one.body?.data?.total ?? 0);
      }
      check(
        `**各状态 total 之和等于全量**（${totals.join('+')}=${totals.reduce((a, b) => a + b, 0)} vs 全量 ${allTotal}）`,
        totals.reduce((a, b) => a + b, 0) === allTotal,
        { totals, allTotal },
      );

      // 非法值必须是**报错**而不是静默忽略（静默忽略正是这次的病根）
      const bad = await api('/api/shop/orders?status=999', { token });
      check('**status 非法值 -> 1001（不再静默忽略）**', bad.body.code === 1001, bad.body);

      const badStr = await api('/api/shop/orders?status=abc', { token });
      check('status=abc -> 1001', badStr.body.code === 1001, badStr.body);

      // 分页与筛选叠加：size=1 时每页只 1 条
      const paged = await api('/api/shop/orders?status=0&page=1&size=1', { token });
      check('筛选 + 分页可叠加（size=1 只返回 1 条）', (paged.body?.data?.list ?? []).length <= 1, (paged.body?.data?.list ?? []).length);
    }
  }

  console.log(`\n=== 6. 流水（含订单扣费）===`);
  {
    const res = await api('/api/wallet/transactions?type=2', { token });
    const rows = res.body?.data?.list ?? [];
    check('存在订单扣费流水', rows.length >= 1, rows.length);
    check(
      '扣费 bill_no 严格符合契约 §2.4：order:{order_id}:item:{item_id}',
      /^order:\d+:item:\d+$/.test(String(rows[0]?.bill_no ?? '')),
      rows[0]?.bill_no,
    );
    check('逐项扣费带 product_code（供对账按产品归集）', rows[0]?.product_code === 'storage', rows[0]?.product_code);
  }

  console.log(`\n=== 7. 产品账单上报 + 日对账（§6）===`);
  {
    // 每次运行用一个**唯一的未来日期**做对账：同库同一天的历史流水/上报会互相污染，
    // 而"明天"这个固定日期重复跑也会累积上一次的上报数据，导致断言不稳定。
    const bizDate = new Date(Date.now() + (3000 + Math.floor(Math.random() * 60000)) * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const txn = (await api('/api/wallet/transactions?type=2', { token })).body?.data?.list ?? [];
    const billNo = txn[0]?.bill_no;
    const amount = txn[0]?.amount_cents;

    const report = await api('/api/internal/reconciliation/report', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: {
        biz_date: bizDate,
        product_code: 'storage',
        bills: [{ bill_no: billNo, amount_cents: amount, type: 2, portal_user_id: userId }],
      },
    });
    check('产品账单上报成功', report.body.code === 0, report.body);

    const noKey = await api('/api/internal/reconciliation/report', {
      method: 'POST',
      body: { biz_date: bizDate, product_code: 'storage', bills: [] },
    });
    check('上报缺 X-Internal-Key -> 1002', noKey.body.code === 1002, noKey.body);

    const run = await api('/api/admin/reconciliation/run', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: { biz_date: bizDate, product_code: 'storage' },
    });
    check('手动对账 code=0', run.body.code === 0, run.body);
    check(
      '该业务日门户无流水、产品上报 1 笔 → 仅产品侧 1 笔（口径正确）',
      run.body?.data?.product_only_count === 1 && run.body?.data?.portal_amount_cents === 0,
      run.body?.data,
    );
    check('产品侧金额 = 上报金额', run.body?.data?.product_amount_cents === amount, run.body?.data?.product_amount_cents);

    // 制造金额不一致：同一 bill_no 报一个不同金额
    await api('/api/internal/reconciliation/report', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { biz_date: bizDate, product_code: 'storage', bills: [{ bill_no: billNo, amount_cents: amount + 1, type: 2 }] },
    });
    const run2 = await api('/api/admin/reconciliation/run', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: { biz_date: bizDate, product_code: 'storage' },
    });
    check('同日产品侧金额变化被如实反映（幂等上报覆盖）', run2.body?.data?.product_amount_cents === amount + 1, run2.body?.data?.product_amount_cents);

    const todayRun = await api('/api/admin/reconciliation/run', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: { biz_date: today, product_code: 'storage' },
    });
    check('今日对账能跑出差异（历史流水 vs 零上报）', todayRun.body?.data?.status === 'diff', todayRun.body?.data?.status);

    const daily = await api(`/api/admin/reconciliation/daily?date=${bizDate}`, { headers: { authorization: `Bearer ${adminToken}` } });
    check('日对账查询返回结果（§6 GET daily）', (daily.body?.data?.list ?? []).length >= 1, daily.body?.data);
    check('结果含金额与差异字段', daily.body?.data?.list?.[0]?.portal_amount_cents !== undefined, daily.body?.data?.list?.[0]);

    const jobs = await api('/api/admin/reconciliation/provision-jobs', { headers: { authorization: `Bearer ${adminToken}` } });
    check('开通任务统计可查（含成功数）', jobs.body.code === 0 && Number(jobs.body?.data?.stats?.['2'] ?? 0) >= 1, jobs.body?.data);
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
