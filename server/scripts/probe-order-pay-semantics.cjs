/**
 * 为 D 组（订单详情 + 支付）实测回答清单里的 P0/P1 问题。
 *
 * 产出真实响应体与耗时，用于 §7「请后端提供真实样例」。
 * 用法（服务在跑）：node scripts/probe-order-pay-semantics.cjs
 */
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const { loginAdmin, clearRateLimitKeys } = require('./lib/admin-auth.cjs');

const stamp = Date.now().toString().slice(-9);

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { ms: Date.now() - started, http: response.status, ...json };
}

const show = (label, r) => console.log(`  ${label}\n    → code=${r.code} ms=${r.ms} data=${JSON.stringify(r.data)}`);

(async () => {
  clearRateLimitKeys();

  console.log('=== 准备：注册用户 + 充值到账（金额足够买 storage-500g=50000 分）===');
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { username: `dq_${stamp}`, password: 'Ab12345678' },
  });
  const token = reg.data.access_token;
  const apply = await api('/api/wallet/recharge/apply', {
    method: 'POST',
    token,
    body: { amount_cents: 100000, remark: 'D 组语义实测' },
  });
  const admin = await loginAdmin(BASE);
  await api(`/api/admin/recharges/${apply.data.apply_id}/confirm`, {
    method: 'POST',
    token: admin.token,
    body: { reject: false },
  });
  const bal = await api('/api/wallet/balance', { token });
  console.log(`  余额 ${bal.data.balance_cents} 分`);

  const products = await api('/api/shop/products?product_code=storage');
  let sku = (products.data.list ?? []).find((p) => Number(p.price_cents) > 0);
  if (!sku) {
    // 商品目录由后台 ProductSyncService 拉取，启动后需要几秒；这里等它落库
    console.log('  商品目录为空，等待后台同步…');
    for (let i = 0; i < 20 && !sku; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const again = await api('/api/shop/products?product_code=storage');
      sku = (again.data.list ?? []).find((p) => Number(p.price_cents) > 0);
    }
  }
  if (!sku) throw new Error('商品目录仍为空（检查产品桩是否在跑 / PRODUCT_STORAGE_BASE_URL 是否指向桩）');
  console.log(`  商品 ${sku.sku_id} 单价 ${sku.price_cents} 分`);

  console.log('\n=== D-Q1 / D-Q9：第一次支付（真实响应体 + 耗时）===');
  const order = await api('/api/shop/orders', {
    method: 'POST',
    token,
    body: { items: [{ product_code: sku.product_code, sku_id: sku.sku_id, quantity: 1 }] },
  });
  const orderId = order.data.order_id;

  const pay1 = await api(`/api/shop/orders/${orderId}/pay`, { method: 'POST', token });
  show('第一次 pay', pay1);

  console.log('\n=== D-Q1-①：项 status=1（开通中）时再点支付 ===');
  const payBusy = await api(`/api/shop/orders/${orderId}/pay`, { method: 'POST', token });
  show('开通中重复支付', payBusy);

  console.log('\n=== 等 worker 跑完，拿到终态 ===');
  let final = null;
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const detail = await api(`/api/shop/orders/${orderId}`, { token });
    const items = detail.data.items ?? [];
    if (items.every((it) => it.status === 2 || it.status === 4)) {
      final = detail.data;
      break;
    }
  }
  console.log(`  终态：订单 status=${final?.status} 项=${JSON.stringify((final?.items ?? []).map((i) => ({ id: i.item_id, status: i.status, instance_id: i.instance_id, fail_reason: i.fail_reason })))}`);

  console.log('\n=== D-Q1-②：订单已到终态（2 全部成功）时再点支付 ===');
  const payDone = await api(`/api/shop/orders/${orderId}/pay`, { method: 'POST', token });
  show('终态重复支付', payDone);

  console.log('\n=== D-Q2：pay 的 3001（余额不足）data 是什么 ===');
  // 建一个大额订单把余额打空：先看余额
  const balNow = await api('/api/wallet/balance', { token });
  console.log(`  当前余额 ${balNow.data.balance_cents} 分`);
  const bigSku = (products.data.list ?? []).filter((p) => Number(p.price_cents) > 0).sort((a, b) => b.price_cents - a.price_cents)[0];
  const need = Number(bigSku.price_cents) * 10;
  console.log(`  最大单价 ${bigSku.price_cents} 分，建 10 件共 ${need} 分（余额不够）`);
  const bigOrder = await api('/api/shop/orders', {
    method: 'POST',
    token,
    body: { items: [{ product_code: bigSku.product_code, sku_id: bigSku.sku_id, quantity: 10 }] },
  });
  console.log(`  建单结果 code=${bigOrder.code} message=${bigOrder.message} data=${JSON.stringify(bigOrder.data)?.slice(0, 200)}`);

  if (bigOrder.code === 0) {
    const payPoor = await api(`/api/shop/orders/${bigOrder.data.order_id}/pay`, { method: 'POST', token });
    show('余额不足 pay（**注意 data**）', payPoor);
  }

  console.log('\n=== D-Q8：查别人的订单 / 不存在的订单 ===');
  const other = await api('/api/auth/register', { method: 'POST', body: { username: `dqo_${stamp}`, password: 'Ab12345678' } });
  const otherToken = other.data.access_token;
  const foreign = await api(`/api/shop/orders/${orderId}`, { token: otherToken });
  show('他人订单详情', foreign);
  const missing = await api('/api/shop/orders/99999999', { token });
  show('不存在的订单详情', missing);
  const foreignPay = await api(`/api/shop/orders/${orderId}/pay`, { method: 'POST', token: otherToken });
  show('支付他人订单', foreignPay);

  console.log('\n=== D-Q6：订单详情是否限流（连打 30 次）===');
  let limited = 0;
  for (let i = 0; i < 30; i += 1) {
    const r = await api(`/api/shop/orders/${orderId}`, { token });
    if (r.code === 1001) limited += 1;
  }
  console.log(`  30 次详情请求中被限流 ${limited} 次 → ${limited === 0 ? '**未限流**' : '**限流了**'}`);

  console.log('\n=== D-Q7：同一订单并发支付 2 次 ===');
  const conc = await api('/api/shop/orders', {
    method: 'POST',
    token,
    body: { items: [{ product_code: sku.product_code, sku_id: sku.sku_id, quantity: 1 }] },
  });
  const concId = conc.data.order_id;
  const [c1, c2] = await Promise.all([
    api(`/api/shop/orders/${concId}/pay`, { method: 'POST', token }),
    api(`/api/shop/orders/${concId}/pay`, { method: 'POST', token }),
  ]);
  console.log(`  并发结果 1：code=${c1.code} accepted=${c1.data?.accepted_items} ms=${c1.ms}`);
  console.log(`  并发结果 2：code=${c2.code} accepted=${c2.data?.accepted_items} ms=${c2.ms}`);
  const afterConc = await api(`/api/shop/orders/${concId}`, { token });
  const deducted = await api('/api/wallet/transactions?type=2&page=1&size=5', { token });
  console.log(`  并发后余额 ${(await api('/api/wallet/balance', { token })).data.balance_cents} 分`);

  console.log('\n=== D-Q9：pay 耗时样本（5 次全新订单，已到账后连跑）===');
  const times = [pay1.ms];
  for (let i = 0; i < 4; i += 1) {
    const o = await api('/api/shop/orders', {
      method: 'POST',
      token,
      body: { items: [{ product_code: sku.product_code, sku_id: sku.sku_id, quantity: 1 }] },
    });
    if (o.code !== 0) break;
    const p = await api(`/api/shop/orders/${o.data.order_id}/pay`, { method: 'POST', token });
    times.push(p.ms);
    if (p.code !== 0) {
      console.log(`  第 ${i + 2} 次支付 code=${p.code}（余额可能已不足），停止采样`);
      break;
    }
  }
  const sorted = [...times].sort((a, b) => a - b);
  console.log(`  样本 ${times.length} 个：${times.join(', ')} ms  最小 ${sorted[0]} 最大 ${sorted[sorted.length - 1]}`);
})().catch((error) => {
  console.error('失败：', error);
  process.exit(1);
});
