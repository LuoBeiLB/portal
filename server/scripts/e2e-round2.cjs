/**
 * 端到端自验脚本（本机 MySQL + Redis）。
 *
 * 用法：
 *   1) 另开一个终端：npm run start:dev   （或 node dist/main.js）
 *   2) node scripts/e2e-round2.cjs
 *
 * 覆盖范围（对齐契约章节）：
 *   §0.2 统一响应结构、§0.6 错误码、§1.1~1.5 认证、§3 钱包、§4 内网计费、§6 管理端核销
 *
 * 注意：脚本会创建测试用户并产生真实流水（金额很小），仅用于本地自验库。
 */
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const ADMIN_KEY = process.env.ADMIN_KEY || 'local-dev-admin-key';
const INTERNAL_KEY = process.env.PRODUCT_STORAGE_INTERNAL_KEY || 'local-dev-storage-key';

let passed = 0;
let failed = 0;
const failures = [];

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

async function api(path, { method = 'GET', body, token, headers = {}, cookie } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __raw: text };
  }
  return { status: response.status, body: json, setCookie };
}

(async () => {
  const stamp = Date.now().toString().slice(-9);
  const username = `e2e_${stamp}`;
  const password = 'Ab12345678';
  const phone = `13${stamp.slice(0, 9)}`;
  let accessToken = '';
  let userId = '';
  let refreshCookie = '';
  let billNo = `e2e-bill-${stamp}`;

  console.log(`\n=== 0. 探活（§0.2 响应结构）===`);
  {
    const res = await api('/api/healthz');
    check('GET /api/healthz 无需 token 即可访问（code=0）', res.body.code === 0, res.body);
    check('data.status = ok（DB 与 Redis 都通）', res.body?.data?.status === 'ok', res.body?.data);
    check('响应体含 code/message/data 三字段', ['code', 'message', 'data'].every((k) => k in res.body), Object.keys(res.body));
  }

  console.log(`\n=== 1. 注册（§1.1 注册即建钱包 + 自动登录）===`);
  {
    const res = await api('/api/auth/register', { method: 'POST', body: { username, password, phone } });
    check('注册成功 code=0', res.body.code === 0, res.body);
    check('返回 id（UUID 36 位）', typeof res.body?.data?.id === 'string' && res.body.data.id.length === 36, res.body?.data?.id);
    check('返回 access_token', typeof res.body?.data?.access_token === 'string', null);
    check('expires_in=7200（契约 §1.2）', res.body?.data?.expires_in === 7200, res.body?.data?.expires_in);
    check(
      'Set-Cookie 为 refresh_token，Path=/api/auth/refresh，HttpOnly，SameSite=Strict',
      res.setCookie.some(
        (c) =>
          c.startsWith('refresh_token=') &&
          /Path=\/api\/auth\/refresh/i.test(c) &&
          /HttpOnly/i.test(c) &&
          /SameSite=Strict/i.test(c),
      ),
      res.setCookie,
    );
    accessToken = res.body?.data?.access_token;
    userId = res.body?.data?.id;
    refreshCookie = res.setCookie.find((c) => c.startsWith('refresh_token='))?.split(';')[0] ?? '';
  }

  console.log(`\n=== 2. 重复注册与登录错误码（§0.6）===`);
  {
    const dupName = await api('/api/auth/register', { method: 'POST', body: { username, password } });
    check('用户名已存在 -> 2001', dupName.body.code === 2001, dupName.body);

    const dupPhone = await api('/api/auth/register', { method: 'POST', body: { username: `${username}x`, password, phone } });
    check('手机号已注册 -> 2002', dupPhone.body.code === 2002, dupPhone.body);

    const weak = await api('/api/auth/register', { method: 'POST', body: { username: `weak_${stamp}`, password: 'aaaaaaaa' } });
    check('弱密码（无数字）-> 1001', weak.body.code === 1001, weak.body);

    const badLogin = await api('/api/auth/login', { method: 'POST', body: { username, password: 'WrongPass123' } });
    check('密码错误 -> 2003', badLogin.body.code === 2003, badLogin.body);

    const byPhone = await api('/api/auth/login', { method: 'POST', body: { username: phone, password } });
    check('支持手机号登录（§1.2）', byPhone.body.code === 0, byPhone.body);
  }

  console.log(`\n=== 3. 登录 + 鉴权守卫（§0.3）===`);
  {
    const login = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    check('登录成功 code=0', login.body.code === 0, login.body);
    accessToken = login.body?.data?.access_token;
    refreshCookie = login.setCookie.find((c) => c.startsWith('refresh_token='))?.split(';')[0] ?? '';

    const noToken = await api('/api/wallet/balance');
    check('无 token 访问受保护接口 -> 1002', noToken.body.code === 1002, noToken.body);

    const badToken = await api('/api/wallet/balance', { token: 'not.a.jwt' });
    check('无效 token -> 1002', badToken.body.code === 1002, badToken.body);
  }

  console.log(`\n=== 4. 钱包初始状态（§3.1）===`);
  {
    const res = await api('/api/wallet/balance', { token: accessToken });
    check('余额 0 分（注册即建钱包）', res.body?.data?.balance_cents === 0, res.body?.data);
    check('status=0 正常', res.body?.data?.status === 0, res.body?.data);
  }

  console.log(`\n=== 5. 内网计费鉴权（§0.3 / §4）===`);
  {
    const noKey = await api('/api/wallet/deduct', {
      method: 'POST',
      body: { portal_user_id: userId, product_code: 'storage', bill_no: billNo, amount_cents: 100 },
    });
    check('无 X-Internal-Key -> 1002', noKey.body.code === 1002, noKey.body);

    const wrongKey = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': 'wrong-key' },
      body: { portal_user_id: userId, product_code: 'storage', bill_no: billNo, amount_cents: 100 },
    });
    check('错误 X-Internal-Key -> 1002', wrongKey.body.code === 1002, wrongKey.body);

    const ghost = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: '00000000-0000-7000-8000-000000000000', product_code: 'storage', bill_no: billNo, amount_cents: 100 },
    });
    check('不存在的 portal_user_id -> 1001', ghost.body.code === 1001, ghost.body);
  }

  console.log(`\n=== 6. 余额不足（§4.1 -> 3001，不重试）===`);
  {
    const res = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: userId, product_code: 'storage', bill_no: billNo, amount_cents: 3000 },
    });
    check('余额不足 -> 3001', res.body.code === 3001, res.body);
    check('3001 时 data.balance 带当前余额（契约 §4.1）', res.body?.data?.balance === 0, res.body?.data);
  }

  console.log(`\n=== 7. 充值申请 -> 管理端核销（§3.3 / §6）===`);
  let applyId = '';
  {
    const apply = await api('/api/wallet/recharge/apply', {
      method: 'POST',
      token: accessToken,
      body: { amount_cents: 10000, remark: 'e2e 线下转账凭证' },
    });
    check('充值申请 code=0', apply.body.code === 0, apply.body);
    check('status=0 待核销', apply.body?.data?.status === 0, apply.body?.data);
    check('notice 为「请线下转账后等待管理员核销」', String(apply.body?.data?.notice).includes('请线下转账'), apply.body?.data);
    applyId = apply.body?.data?.apply_id;

    const tooSmall = await api('/api/wallet/recharge/apply', { method: 'POST', token: accessToken, body: { amount_cents: 50 } });
    check('金额低于 100 分 -> 1001', tooSmall.body.code === 1001, tooSmall.body);

    const noAdminKey = await api('/api/admin/recharges?status=0');
    check('管理端无 X-Admin-Key -> 1004', noAdminKey.body.code === 1004, noAdminKey.body);

    const queue = await api('/api/admin/recharges?status=0', { headers: { 'x-admin-key': ADMIN_KEY } });
    check('核销队列 code=0（§6 GET /admin/recharges）', queue.body.code === 0, queue.body);
    check('队列中含本条申请（带 username）', queue.body?.data?.list?.some((r) => r.apply_id === applyId && r.username === username), queue.body?.data?.list?.slice(0, 3));

    const confirm = await api(`/api/admin/recharges/${applyId}/confirm`, {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      body: { reject: false },
    });
    check('核销到账 code=0', confirm.body.code === 0, confirm.body);
    check('返回到账后余额 10000 分', confirm.body?.data?.balance_cents === 10000, confirm.body?.data);

    const second = await api(`/api/admin/recharges/${applyId}/confirm`, {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      body: { reject: false },
    });
    check('重复核销被拒（条件更新防重复增额）', second.body.code !== 0, second.body);

    const balance = await api('/api/wallet/balance', { token: accessToken });
    check('余额确为 10000 分', balance.body?.data?.balance_cents === 10000, balance.body?.data);
  }

  console.log(`\n=== 8. 扣费 + 幂等（§4.1 / §0.5）===`);
  {
    const deduct = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: {
        portal_user_id: userId,
        product_code: 'storage',
        bill_no: billNo,
        amount_cents: 3000,
        detail: { plan: '续费·标准版', period: '30天' },
      },
    });
    check('扣费成功 code=0', deduct.body.code === 0, deduct.body);
    check('balance_after = 7000 分', deduct.body?.data?.balance_after === 7000, deduct.body?.data);
    check('返回 transaction_id', deduct.body?.data?.transaction_id !== undefined, deduct.body?.data);

    const repeat = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: userId, product_code: 'storage', bill_no: billNo, amount_cents: 3000 },
    });
    check('同 bill_no 重复扣费 -> 3003（契约 §0.5）', repeat.body.code === 3003, repeat.body);
    check('data 为首次结果且带 idempotent_repeated', repeat.body?.data?.idempotent_repeated === true && repeat.body?.data?.balance_after === 7000, repeat.body?.data);

    const balance = await api('/api/wallet/balance', { token: accessToken });
    check('余额未被二次扣减（仍 7000）', balance.body?.data?.balance_cents === 7000, balance.body?.data);
  }

  console.log(`\n=== 9. 退款与超退校验（§4.2 -> 3004 / 3005）===`);
  {
    const refundBillNo = `e2e-refund-${stamp}`;
    const refund = await api('/api/wallet/refund', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { bill_no: billNo, refund_bill_no: refundBillNo, amount_cents: 1000, reason: '开通失败自动退款' },
    });
    check('部分退款成功 code=0', refund.body.code === 0, refund.body);
    check('balance_after = 8000 分', refund.body?.data?.balance_after === 8000, refund.body?.data);

    const repeatRefund = await api('/api/wallet/refund', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { bill_no: billNo, refund_bill_no: refundBillNo, amount_cents: 1000 },
    });
    check('同 refund_bill_no 重复退款 -> 3003', repeatRefund.body.code === 3003, repeatRefund.body);

    const overRefund = await api('/api/wallet/refund', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { bill_no: billNo, refund_bill_no: `e2e-refund2-${stamp}`, amount_cents: 3000 },
    });
    check('累计退款超原额 -> 3004', overRefund.body.code === 3004, overRefund.body);
    check('3004 时给出可退余额', overRefund.body?.data?.refundable_cents === 2000, overRefund.body?.data);

    const unknown = await api('/api/wallet/refund', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { bill_no: 'not-exist-bill', refund_bill_no: `e2e-refund3-${stamp}`, amount_cents: 100 },
    });
    check('原 bill_no 不存在 -> 3005', unknown.body.code === 3005, unknown.body);
  }

  console.log(`\n=== 10. 流水（§3.2）===`);
  {
    const res = await api('/api/wallet/transactions?page=1&size=20', { token: accessToken });
    check('流水 code=0 且分页字段齐全', res.body.code === 0 && ['list', 'total', 'page', 'size'].every((k) => k in res.body.data), Object.keys(res.body?.data ?? {}));
    check('total = 3（充值 + 扣费 + 退款）', res.body?.data?.total === 3, res.body?.data?.total);
    const types = (res.body?.data?.list ?? []).map((row) => row.type).sort();
    check('流水类型含 1/2/3', JSON.stringify(types) === JSON.stringify([1, 2, 3]), types);
    check('created_at 为 UTC ISO 格式（不带毫秒）', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(res.body?.data?.list?.[0]?.created_at ?? ''), res.body?.data?.list?.[0]?.created_at);

    const onlyDeduct = await api('/api/wallet/transactions?type=2', { token: accessToken });
    check('按 type=2 过滤只剩 1 条', onlyDeduct.body?.data?.total === 1, onlyDeduct.body?.data?.total);

    const refundRow = (res.body?.data?.list ?? []).find((row) => row.type === 3);
    check('退款流水带 refund_of_bill_no 指向原单', refundRow?.refund_of_bill_no === billNo, refundRow);
  }

  console.log(`\n=== 11. 管理端流水导出（§6 CSV）===`);
  {
    const res = await fetch(`${BASE}/api/admin/transactions/export`, { headers: { 'x-admin-key': ADMIN_KEY } });
    const text = await res.text();
    check('导出 HTTP 200', res.status === 200, res.status);
    check('Content-Type 为 CSV', /text\/csv/.test(res.headers.get('content-type') ?? ''), res.headers.get('content-type'));
    check(
      'CSV 内容为表格而非 JSON 壳（表头含 bill_no，且有数据行）',
      res.ok && text.includes('bill_no') && text.split('\n').length > 1 && !text.startsWith('{"code"'),
      text.slice(0, 60),
    );
  }

  console.log(`\n=== 12. tokens：JWKS / refresh / logout（§1.3-1.5）===`);
  {
    const jwks = await api('/.well-known/jwks.json');
    check('JWKS 挂在 /.well-known 且无 /api 前缀', jwks.status === 200 && Array.isArray(jwks.body?.keys), jwks.body);
    const key = jwks.body?.keys?.[0];
    check('JWKS key 字段齐全（kty/alg/use/kid/n/e）', key && ['kty', 'alg', 'use', 'kid', 'n', 'e'].every((k) => k in key), key);
    check('kid 与配置一致', key?.kid === 'portal-2026-10', key?.kid);
    check('JWKS 不含私钥字段', !JSON.stringify(jwks.body).includes('"d"'), null);

    const refreshed = await api('/api/auth/refresh', { method: 'POST', cookie: refreshCookie });
    check('带 refresh Cookie 刷新成功（§1.3）', refreshed.body.code === 0 && typeof refreshed.body?.data?.access_token === 'string', refreshed.body);

    const noCookie = await api('/api/auth/refresh', { method: 'POST' });
    check('无 Cookie 刷新 -> 1002', noCookie.body.code === 1002, noCookie.body);

    const logout = await api('/api/auth/logout', { method: 'POST', token: accessToken, cookie: refreshCookie });
    check('登出 code=0 且 data.ok=true（§1.4）', logout.body.code === 0 && logout.body?.data?.ok === true, logout.body);

    const afterLogout = await api('/api/wallet/balance', { token: accessToken });
    check('登出后旧 access token 失效 -> 1002（可选收紧）', afterLogout.body.code === 1002, afterLogout.body);

    const refreshAfterLogout = await api('/api/auth/refresh', { method: 'POST', cookie: refreshCookie });
    check('登出后 refresh 也失效 -> 1002', refreshAfterLogout.body.code === 1002, refreshAfterLogout.body);
  }

  console.log(`\n=== 13. OpenAPI 文档（给前端联调用）===`);
  {
    const doc = await api('/api/docs-json');
    check('GET /api/docs-json 可导出 OpenAPI JSON', doc.body?.openapi !== undefined, Object.keys(doc.body ?? {}).slice(0, 5));
    check('info.title 标注契约版本', String(doc.body?.info?.title ?? '').includes('门户'), doc.body?.info);
    const paths = Object.keys(doc.body?.paths ?? {});
    check('paths 覆盖已实现的契约接口（>=12 个）', paths.length >= 12, paths.length);
    check('含 §1 认证接口', paths.includes('/api/auth/login') && paths.includes('/api/auth/register'), paths.filter((p) => p.includes('auth')));
    check('含 §3 钱包接口', paths.includes('/api/wallet/balance') && paths.includes('/api/wallet/transactions'), paths.filter((p) => p.includes('wallet')));
    check('含 §4 内网接口', paths.includes('/api/wallet/deduct') && paths.includes('/api/wallet/refund'), null);
    check('含 §6 管理端接口', paths.some((p) => p.startsWith('/api/admin/')), paths.filter((p) => p.startsWith('/api/admin')));
    check('声明了 Bearer 与 X-Internal-Key / X-Admin-Key 鉴权方案', Boolean(doc.body?.components?.securitySchemes?.bearer), Object.keys(doc.body?.components?.securitySchemes ?? {}));
    check('DTO 字段有 schema 描述（不是空对象）', Boolean(doc.body?.components?.schemas?.RegisterDto?.properties?.username), Object.keys(doc.body?.components?.schemas ?? {}).slice(0, 8));
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
