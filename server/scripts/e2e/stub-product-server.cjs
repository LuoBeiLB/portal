/**
 * 云存储侧接口桩（仅供端到端自验用，**不是生产代码**）。
 *
 * 模拟契约 §5 要求产品实现的两个接口：
 *   GET  /internal/products   商品目录
 *   POST /internal/provision  开通（幂等键 order_item_id）
 *
 * ## 密钥来源（重要）
 * 校验的 `X-Internal-Key` 优先取 `STUB_PRODUCT_INTERNAL_KEY`（默认 `stub-storage-key`），
 * **不再**取门户的 `PRODUCT_STORAGE_INTERNAL_KEY` —— 那个值现在是**真实云存储的密钥**，
 * 不该出现在测试桩里。e2e 脚本会同时给桩和门户注入 STUB 变量，两边自然对上。
 *
 * 启动：
 *   node scripts/stub-product-server.cjs
 *   PORT=9999 node scripts/stub-product-server.cjs
 * 可选故障注入（用于验证自动退款 / 重试路径）：
 *   PROVISION_MODE=fail      每次都返回 4004 库存不足（业务失败 → 立即退款）
 *   PROVISION_MODE=error     每次都返回 5001 内部错误（系统失败 → 重试到用尽再退款）
 *   PROVISION_MODE=timeout   每次都挂起不返回（验证 30s 超时处理）
 *   PROVISION_MODE=flaky     前 2 次失败、第 3 次成功（验证幂等重试）
 */
const http = require('node:http');

const PORT = Number(process.env.PORT || 8081);
const INTERNAL_KEY =
  process.env.STUB_PRODUCT_INTERNAL_KEY || process.env.PRODUCT_INTERNAL_KEY || 'stub-storage-key';
const MODE = process.env.PROVISION_MODE || 'ok';

/** 幂等存储：order_item_id -> 首次开通结果 */
const provisionStore = new Map();
/** 调用计数：用于 flaky 模式 */
const attempts = new Map();
/** 最近一次开通请求体：e2e 用它断言周期字段（period_hours / period_days）下发是否正确 */
let lastProvision = null;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const PRODUCTS = [
  {
    sku_id: 'storage-500g',
    name: '云存储·500G',
    spec: { quota_gb: 500, transfer: 'unlimited' },
    price_cents: 3000,
    billing_mode: 1,
    period_days: 30,
    stock: 100,
  },
  {
    sku_id: 'storage-2t',
    name: '云存储·2T',
    spec: { quota_gb: 2048, transfer: 'unlimited' },
    price_cents: 9900,
    billing_mode: 1,
    period_days: 30,
    stock: null, // 不限量
  },
  {
    sku_id: 'storage-usage',
    name: '云存储·按量付费',
    spec: { quota_gb: 100, note: '后付费' },
    price_cents: 0,
    billing_mode: 2,
    period_days: null,
    stock: null,
  },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const key = req.headers['x-internal-key'];

  if (key !== INTERNAL_KEY) {
    return send(res, 401, { code: 1002, message: 'invalid X-Internal-Key', data: null });
  }

  // 契约 §5.1 商品目录
  if (req.method === 'GET' && url.pathname === '/internal/products') {
    console.log(`[stub] GET /internal/products -> ${PRODUCTS.length} 个商品`);
    return send(res, 200, { code: 0, message: 'ok', data: { products: PRODUCTS } });
  }

  // 契约 §5.2 开通
  if (req.method === 'POST' && url.pathname === '/internal/provision') {
    const body = await readBody(req);
    const itemId = String(body.order_item_id ?? '');
    const count = (attempts.get(itemId) ?? 0) + 1;
    attempts.set(itemId, count);
    // 记录收到的入参，供 e2e 断言「周期字段下发是否正确」（见 GET /__debug/last-provision）
    lastProvision = { at: Date.now(), body };
    console.log(`[stub] POST /internal/provision item=${itemId} sku=${body.sku_id} mode=${MODE} 第${count}次`);

    if (!itemId || !body.sku_id) {
      return send(res, 200, { code: 1001, message: 'order_item_id / sku_id 必填', data: null });
    }

    // 幂等：同一 order_item_id 重复调用直接返回首次结果
    if (provisionStore.has(itemId)) {
      console.log(`[stub]   命中幂等，返回首次结果`);
      return send(res, 200, { code: 0, message: 'ok', data: provisionStore.get(itemId) });
    }

    if (MODE === 'fail') {
      return send(res, 200, { code: 4004, message: '库存不足', data: null });
    }
    if (MODE === 'error') {
      return send(res, 200, { code: 5001, message: '内部错误', data: null });
    }
    if (MODE === 'timeout') {
      // 故意不返回，让门户侧 30s 超时
      return;
    }
    if (MODE === 'flaky' && count < 3) {
      return send(res, 200, { code: 5001, message: `第 ${count} 次故意失败`, data: null });
    }

    const result = {
      instance_id: `st-${itemId}`,
      expire_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      quantity: body.quantity ?? 1,
    };
    provisionStore.set(itemId, result);
    return send(res, 200, { code: 0, message: 'ok', data: result });
  }

  // 便于自验：重置幂等存储
  if (req.method === 'POST' && url.pathname === '/__reset') {
    provisionStore.clear();
    attempts.clear();
    lastProvision = null;
    return send(res, 200, { code: 0, message: 'reset', data: null });
  }

  // 便于自验：回看最近一次开通请求体（断言周期字段下发）
  if (req.method === 'GET' && url.pathname === '/__debug/last-provision') {
    return send(res, 200, { code: 0, message: 'ok', data: lastProvision });
  }

  send(res, 404, { code: 1001, message: 'not found', data: null });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub] 云存储桩已启动 http://127.0.0.1:${PORT}  key=${INTERNAL_KEY} mode=${MODE}`);
});
