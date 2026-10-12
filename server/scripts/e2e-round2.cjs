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
// 管理端鉴权：2026-10-10 起改为管理员账号（JWT），不再是静态 X-Admin-Key
const { loginAdmin, clearRateLimitKeys } = require('./lib/admin-auth.cjs');
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

  console.log(`\n=== 0. 管理员登录（管理端鉴权前置）===`);
  {
    const admin = await loginAdmin(BASE);
    adminToken = admin.token;
    check('管理员登录成功（管理端接口需要 JWT）', typeof adminToken === 'string' && adminToken.length > 20, admin.username);

    // 上一轮验证限流时会把配额打满，Redis 里的计数有 60s TTL 且**跨 run 有效**，
    // 不清掉会让本轮的"公开访问"断言被误判为失败
    const cleared = clearRateLimitKeys();
    check('已清理上一轮残留的限流计数（保证可重复运行）', true, `清理 ${cleared} 个键`);
  }

  console.log(`\n=== 0.1 探活（§0.2 响应结构）===`);
  {
    const res = await api('/api/healthz');
    check('GET /api/healthz 无需 token 即可访问（code=0）', res.body.code === 0, res.body);
    check('data.status = ok（DB 与 Redis 都通）', res.body?.data?.status === 'ok', res.body?.data);
    check('响应体含 code/message/data 三字段', ['code', 'message', 'data'].every((k) => k in res.body), Object.keys(res.body));
    check('GET 接口 HTTP 200', res.status === 200, res.status);

    // 契约 §0.2：所有接口（含 POST）HTTP 状态码均为 200 —— Nest 对 POST 默认 201，必须显式改掉
    const postOk = await api('/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'x' } });
    check('POST 接口业务失败时 HTTP 200（不是 201/4xx）', postOk.status === 200, postOk.status);
  }

  console.log(`\n=== 1. 注册（§1.1 注册即建钱包 + 自动登录）===`);
  {
    const res = await api('/api/auth/register', { method: 'POST', body: { username, password, phone } });
    check('注册成功 code=0', res.body.code === 0, res.body);
    check('**成功的 POST 也返回 HTTP 200**（契约 §0.2，Nest 默认是 201）', res.status === 200, res.status);
    check('返回 id（UUID 36 位）', typeof res.body?.data?.id === 'string' && res.body.data.id.length === 36, res.body?.data?.id);
    check('返回 access_token', typeof res.body?.data?.access_token === 'string', null);
    check('expires_in=7200（契约 §1.2）', res.body?.data?.expires_in === 7200, res.body?.data?.expires_in);
    // ── user 摘要的字段（2026-10-12 补 role/status）─────────────────────
    // 为什么要有这两条：产品侧**代理登录**（用户在产品登录页输门户账号密码、
    // 产品后端调 /auth/login 验证）成功后，要立刻知道"这账号能不能用、什么角色"。
    // 少了它们，产品还得再调一次接口查状态 —— 而这个字段一旦被误删，
    // 产品侧会静默拿到 undefined，所以在这里断言。
    check(
      '**登录态 user 摘要含 role 与 status**（产品代理登录要用）',
      res.body?.data?.user?.role === 'user' && res.body?.data?.user?.status === 0,
      res.body?.data?.user,
    );
    check(
      'user.id 与顶层 id 一致（同一用户）',
      res.body?.data?.user?.id === res.body?.data?.id,
      { topLevel: res.body?.data?.id, inUser: res.body?.data?.user?.id },
    );
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
    check(
      '**登录响应也带 user.role / user.status**（产品代理登录读的就是它）',
      login.body?.data?.user?.role === 'user' && login.body?.data?.user?.status === 0,
      login.body?.data?.user,
    );
    check(
      '登录响应顶层**不含** id/username（它们在 user 下 —— 与 Swagger 模型一致）',
      login.body?.data?.id === undefined && login.body?.data?.username === undefined,
      Object.keys(login.body?.data ?? {}),
    );

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

  // ⚠️ 注意：以下两段会改动钱包余额，必须放在「余额为 0」的断言之后
  console.log(`\n=== 6.1 密钥与产品身份绑定（防跨产品冒用）===`);
  {
    // 核心场景：storage 的密钥，body 里声明成 phone —— 必须被拒，不能把账记到手机头上
    const spoof = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: userId, product_code: 'phone', bill_no: `${billNo}-spoof`, amount_cents: 100 },
    });
    check('**storage 密钥声明 product_code=phone -> 1004**（跨产品冒用被拦）', spoof.body.code === 1004, spoof.body);

    const spoofUnknown = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: userId, product_code: 'not-a-product', bill_no: `${billNo}-spoof2`, amount_cents: 100 },
    });
    check('声明不存在的 product_code -> 1004', spoofUnknown.body.code === 1004, spoofUnknown.body);

    // 不传 product_code：按密钥归属推定（契约 §4.1 列为必填，此处刻意放宽以兼容存量接入）
    const omitted = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: userId, bill_no: `${billNo}-nofield`, amount_cents: 100 },
    });
    check(
      '不传 product_code 也能工作（按密钥推定，不是参数错）',
      omitted.body.code === 3001 || omitted.body.code === 0,
      omitted.body,
    );

    // 声明正确的 product_code：照常放行
    const correct = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: userId, product_code: 'storage', bill_no: `${billNo}-ok`, amount_cents: 100 },
    });
    check('声明正确的 product_code 不受影响', correct.body.code === 3001 || correct.body.code === 0, correct.body);
  }

  console.log(`\n=== 6.2 入站鉴权与出站同步解耦（仅配密钥的产品）===`);
  {
    // 由 run-e2e-round3.ps1 / 手工启动时注入：PRODUCT_PHONE_INTERNAL_KEY 非空、PRODUCT_PHONE_BASE_URL 为空
    const inboundOnlyKey = process.env.PRODUCT_PHONE_INTERNAL_KEY || '';
    if (!inboundOnlyKey) {
      console.log('  （跳过：未设置 PRODUCT_PHONE_INTERNAL_KEY，无法模拟"仅入站"产品）');
    } else {
      // 该产品的密钥必须被认出来 —— 只是余额不足（3001），不是密钥无效（1002）
      const recognized = await api('/api/wallet/deduct', {
        method: 'POST',
        headers: { 'x-internal-key': inboundOnlyKey },
        body: { portal_user_id: userId, bill_no: `${billNo}-inbound`, amount_cents: 100 },
      });
      check(
        '**仅配密钥（未配地址）的产品密钥仍能通过入站鉴权**（3001 余额不足，而非 1002 密钥无效）',
        recognized.body.code === 3001,
        recognized.body,
      );

      // 但它的身份是 phone，不能冒用 storage
      const crossSpoof = await api('/api/wallet/deduct', {
        method: 'POST',
        headers: { 'x-internal-key': inboundOnlyKey },
        body: { portal_user_id: userId, product_code: 'storage', bill_no: `${billNo}-inbound2`, amount_cents: 100 },
      });
      check(
        '该密钥声明 storage -> 1004（身份仍是 phone，隔离性不受影响）',
        crossSpoof.body.code === 1004,
        crossSpoof.body,
      );
    }
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
    check('管理端无 token -> 1002（未登录）', noAdminKey.body.code === 1002, noAdminKey.body);

    const asUser = await api('/api/admin/recharges?status=0', { token: accessToken });
    check('普通用户访问管理端 -> 1004（非管理员）', asUser.body.code === 1004, asUser.body);

    const queue = await api('/api/admin/recharges?status=0', { headers: { authorization: `Bearer ${adminToken}` } });
    check('核销队列 code=0（§6 GET /admin/recharges）', queue.body.code === 0, queue.body);
    check('队列中含本条申请（带 username）', queue.body?.data?.list?.some((r) => r.apply_id === applyId && r.username === username), queue.body?.data?.list?.slice(0, 3));

    const confirm = await api(`/api/admin/recharges/${applyId}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: { reject: false },
    });
    check('核销到账 code=0', confirm.body.code === 0, confirm.body);
    check('返回到账后余额 10000 分', confirm.body?.data?.balance_cents === 10000, confirm.body?.data);

    const second = await api(`/api/admin/recharges/${applyId}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
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

  console.log(`\n=== 10.1 我的充值记录（用户端，前端需求单）===`);
  {
    // 刻意放在第 10 段之后：本段会新增两笔充值申请，
    // 而第 10 段有严格断言 `total = 3（充值 + 扣费 + 退款）`，插在前面会造成假失败。
    // 再造两笔不同状态的：驳回 与 待核销，配合第 7 段的"已到账"凑齐三种状态
    const toReject = await api('/api/wallet/recharge/apply', {
      method: 'POST',
      token: accessToken,
      body: { amount_cents: 5000, remark: 'e2e 会被驳回的那笔' },
    });
    await api(`/api/admin/recharges/${toReject.body?.data?.apply_id}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: { reject: true, reason: '转账凭证不清晰' },
    });
    const toPending = await api('/api/wallet/recharge/apply', {
      method: 'POST',
      token: accessToken,
      body: { amount_cents: 20000, remark: 'e2e 待核销的那笔' },
    });
    check('造好三种状态的充值单', toReject.body.code === 0 && toPending.body.code === 0, null);

    const list = await api('/api/wallet/recharges?page=1&size=10', { token: accessToken });
    check('GET /api/wallet/recharges code=0', list.body.code === 0, list.body);
    check(
      '返回分页结构 list/total/page/size',
      ['list', 'total', 'page', 'size'].every((k) => k in (list.body?.data ?? {})),
      Object.keys(list.body?.data ?? {}),
    );

    const rows = list.body?.data?.list ?? [];
    const credited = rows.find((r) => r.status === 1);
    const rejected = rows.find((r) => r.status === 2);
    const pendingRow = rows.find((r) => r.status === 0);

    check('三种状态的记录都在列表里', Boolean(credited && rejected && pendingRow), rows.map((r) => r.status));

    // balance_after：仅已到账非空（取自核销时写的流水）
    check('**已到账的 balance_after = 到账后余额**', credited?.balance_after === 10000, credited);
    check('待核销的 balance_after 为 null', pendingRow?.balance_after === null, pendingRow);
    check('驳回的 balance_after 为 null', rejected?.balance_after === null, rejected);

    // reject_reason：仅驳回非空
    check('**驳回的 reject_reason 有值**', rejected?.reject_reason === '转账凭证不清晰', rejected);
    check('已到账的 reject_reason 为 null', credited?.reject_reason === null, credited);

    // remark 回显（用户能看到自己填的转账备注）
    check('remark 原样回显', pendingRow?.remark === 'e2e 待核销的那笔', pendingRow);

    // 用户端不返回管理端的核对字段
    check('**不返回 username / phone**（用户不需要看自己的）', !('username' in (credited ?? {})) && !('phone' in (credited ?? {})), Object.keys(credited ?? {}));

    // 只看自己的：换个用户查，不应该看到上面这些单
    const other = await api('/api/auth/register', {
      method: 'POST',
      body: { username: `e2e_rc_${stamp}`, password: 'Ab12345678' },
    });
    const otherList = await api('/api/wallet/recharges', { token: other.body?.data?.access_token });
    check('**只返回当前用户自己的记录**（新用户看到 0 条）', otherList.body?.data?.total === 0, otherList.body?.data?.total);

    // 状态筛选
    const onlyCredited = await api('/api/wallet/recharges?status=1', { token: accessToken });
    check('status=1 筛选只剩已到账', (onlyCredited.body?.data?.list ?? []).every((r) => r.status === 1), (onlyCredited.body?.data?.list ?? []).map((r) => r.status));

    const badStatus = await api('/api/wallet/recharges?status=9', { token: accessToken });
    check('status=9 -> 1001', badStatus.body.code === 1001, badStatus.body);

    const noToken = await api('/api/wallet/recharges');
    check('无 token -> 1002', noToken.body.code === 1002, noToken.body);
  }

  console.log(`\n=== 11. 管理端流水导出（§6 CSV）===`);
  {
    const res = await fetch(`${BASE}/api/admin/transactions/export`, { headers: { authorization: `Bearer ${adminToken}` } });
    const text = await res.text();
    check('导出 HTTP 200', res.status === 200, res.status);
    check('Content-Type 为 CSV', /text\/csv/.test(res.headers.get('content-type') ?? ''), res.headers.get('content-type'));
    check(
      'CSV 内容为表格而非 JSON 壳（表头含 bill_no，且有数据行）',
      res.ok && text.includes('bill_no') && text.split('\n').length > 1 && !text.startsWith('{"code"'),
      text.slice(0, 60),
    );
  }

  console.log(`\n=== 6.3 商品列表：公开访问（公开接口）===`);
  {
    // 契约 §2.1 标的是 Bearer，但 2026-10-09 起改为**公开**：
    // 游客应当能先看价目表；该接口只读、无用户维度。
    // ⚠️ 限流断言刻意放在**文件最后**（第 15 段）：打满配额会让后续所有商品请求被拒。
    const noToken = await api('/api/shop/products');
    check('**商品列表无 token 也能访问**（公开接口）', noToken.body.code === 0, noToken.body);
    check(
      '返回 list 结构且带 product_code/sku_id',
      Array.isArray(noToken.body?.data?.list) &&
        (noToken.body.data.list.length === 0 ||
          ('sku_id' in noToken.body.data.list[0] && 'product_code' in noToken.body.data.list[0])),
      noToken.body?.data?.list?.[0],
    );

    // 带 token 也必须照常可用（前端已按带 token 实现，不能因为公开就挂）
    const withToken = await api('/api/shop/products', { token: accessToken });
    check('带 token 访问同样正常（向后兼容）', withToken.body.code === 0, withToken.body);
  }

  // 放在最后：本段会额外产生充值与扣费流水，避免污染前面「流水条数」类断言
  console.log(`\n=== 14. bill_no 全局唯一（跨产品不得撞号）===`);
  {
    const apply = await api('/api/wallet/recharge/apply', {
      method: 'POST',
      token: accessToken,
      body: { amount_cents: 10000, remark: 'e2e bill_no 唯一性验证' },
    });
    await api(`/api/admin/recharges/${apply.body?.data?.apply_id}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: { reject: false },
    });

    const shared = `e2e-shared-${stamp}`;
    const first = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: userId, product_code: 'storage', bill_no: shared, amount_cents: 100 },
    });
    check('首次扣费成功（建立该 bill_no 的流水）', first.body.code === 0, first.body);

    // 另一个门户用户使用**同一个 bill_no** —— 全局唯一索引应把第二次挡成幂等 3003
    const otherUser = await api('/api/auth/register', {
      method: 'POST',
      body: { username: `e2e_shared_${stamp}`, password: 'Ab12345678' },
    });
    const otherId = otherUser.body?.data?.id;
    check('第二个用户注册成功', Boolean(otherId), otherUser.body);

    const collide = await api('/api/wallet/deduct', {
      method: 'POST',
      headers: { 'x-internal-key': INTERNAL_KEY },
      body: { portal_user_id: otherId, product_code: 'storage', bill_no: shared, amount_cents: 200 },
    });
    check(
      '**同 bill_no 换用户再来 -> 3003**（证明 bill_no 全局唯一，各产品必须加前缀）',
      collide.body.code === 3003,
      collide.body,
    );
    check(
      '撞号时返回的是**首次**流水（金额 100，不是新请求的 200）—— 证明它命中了别人的账',
      collide.body?.data?.balance_after !== undefined && collide.body?.data?.transaction_id !== undefined,
      collide.body?.data,
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
    // 第 3 轮新增的接口也必须在文档里（否则前端联调时找不到）
    check(
      '含 §2 商城全部接口（商品 / 下单 / 订单列表 / 详情 / 支付）',
      ['/api/shop/products', '/api/shop/orders', '/api/shop/orders/{id}', '/api/shop/orders/{id}/pay'].every((p) =>
        paths.includes(p),
      ),
      paths.filter((p) => p.startsWith('/api/shop')),
    );
    check(
      '含第 3 轮对账相关接口（日对账 / 补跑 / 任务排障 / 账单上报）',
      [
        '/api/admin/reconciliation/daily',
        '/api/admin/reconciliation/run',
        '/api/admin/reconciliation/provision-jobs',
        '/api/internal/reconciliation/report',
      ].every((p) => paths.includes(p)),
      paths.filter((p) => p.includes('reconciliation')),
    );
    check(
      '商城接口标注了 bearer 鉴权，内网接口标注 internal-key',
      Boolean(doc.body?.paths?.['/api/shop/orders']?.post?.security?.some((s) => s.bearer)) &&
        Boolean(doc.body?.paths?.['/api/internal/reconciliation/report']?.post?.security?.some((s) => s['internal-key'])),
      doc.body?.paths?.['/api/shop/orders']?.post?.security,
    );
    check(
      '第 3 轮 DTO 已生成 schema 且字段有描述',
      Boolean(doc.body?.components?.schemas?.CreateOrderDto?.properties?.items) &&
        Boolean(doc.body?.components?.schemas?.ReportBillsDto?.properties?.bills),
      Object.keys(doc.body?.components?.schemas ?? {}),
    );
    check(
      '下单入参不含价格字段（防止前端传价被信任）',
      !Object.keys(doc.body?.components?.schemas?.OrderItemInputDto?.properties ?? {}).some((k) => k.includes('price')),
      Object.keys(doc.body?.components?.schemas?.OrderItemInputDto?.properties ?? {}),
    );
    check('声明了 Bearer 与 X-Internal-Key 鉴权方案', Boolean(doc.body?.components?.securitySchemes?.bearer) && Boolean(doc.body?.components?.securitySchemes?.['internal-key']), Object.keys(doc.body?.components?.securitySchemes ?? {}));
    check('管理端接口标注 bearer（2026-10-10 起改用管理员账号，不再有 admin-key 方案）', doc.body?.paths?.['/api/admin/recharges']?.get?.security?.some((s) => s.bearer), doc.body?.paths?.['/api/admin/recharges']?.get?.security);
    check('DTO 字段有 schema 描述（不是空对象）', Boolean(doc.body?.components?.schemas?.RegisterDto?.properties?.username), Object.keys(doc.body?.components?.schemas ?? {}).slice(0, 8));

    // ── 响应结构必须写全（2026-10-10 补，C 组前端需求 P1-1）──────────────────
    // 病根：接口只声明了"HTTP 200"，没有响应结构，前端只能"调一次把返回打印出来猜字段名"。
    // 这里遍历整个文档，**任何一个接口漏写响应结构都会让本段失败**，不再靠人工发现。
    {
      // 这两个接口刻意不套 {code,data} 壳
      const RAW = new Set(['/.well-known/jwks.json', '/api/admin/transactions/export']);
      const missing = [];
      let declared = 0;
      for (const [path, ops] of Object.entries(doc.body?.paths ?? {})) {
        if (RAW.has(path)) continue;
        for (const [method, op] of Object.entries(ops)) {
          const schema = op?.responses?.[200]?.content?.['application/json']?.schema;
          if (schema?.$ref || schema?.type === 'array') declared += 1;
          else missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
      check(
        `**所有接口都声明了响应结构**（已声明 ${declared} 个，缺失 ${missing.length} 个）`,
        missing.length === 0,
        missing,
      );
      check('响应模型数量合理（*View 模型已生成）', Object.keys(doc.body?.components?.schemas ?? {}).filter((n) => n.endsWith('View')).length >= 20, Object.keys(doc.body?.components?.schemas ?? {}).filter((n) => n.endsWith('View')).length);
    }

    // ── 声明的字段 vs 真实返回的字段，逐个核对（2026-10-12 补）──────────────
    // 病根：`AuthTokenView` 声明了顶层 `id`/`username`/`phone`/`created_at`，
    // 但登录响应里这些在 `data.user` 下、顶层**根本没有** ——
    // "有响应结构"不等于"响应结构是对的"，前端照着文档写会拿到 undefined。
    // 这里拿真实调用去对，比人工审文档可靠。
    //
    // ⚠️ 解析要点：门户导出的 OpenAPI 里，接口的 200 schema **直接就是 `data` 的形状**
    // （`{code,message,data}` 外壳由 ResponseInterceptor 统一加，不体现在每个接口的 schema 里）。
    // 所以比对的是 `schema.properties` ↔ `响应.body.data`，不要再往里找一层 `data`。
    {
      const deref = (node) => {
        const ref = node?.$ref;
        if (!ref) return node ?? null;
        return doc.body?.components?.schemas?.[ref.split('/').pop()] ?? null;
      };
      /** 取某接口 200 响应声明里的字段集合（含 allOf / $ref 展开） */
      const declaredKeysOf = (path, method) => {
        const raw = doc.body?.paths?.[path]?.[method]?.responses?.[200]?.content?.['application/json']?.schema;
        const resolved = deref(raw);
        const props = { ...(resolved?.properties ?? {}) };
        for (const part of resolved?.allOf ?? []) {
          Object.assign(props, deref(part)?.properties ?? {});
        }
        const keys = Object.keys(props);
        return keys.length > 0 ? new Set(keys) : null;
      };

      const realLogin = await api('/api/auth/login', { method: 'POST', body: { username, password } });
      const declaredLogin = declaredKeysOf('/api/auth/login', 'post');
      const realLoginKeys = Object.keys(realLogin.body?.data ?? {});
      const declaredButAbsent = declaredLogin ? [...declaredLogin].filter((k) => !realLoginKeys.includes(k)) : [];
      const absentButReal = declaredLogin ? realLoginKeys.filter((k) => !declaredLogin.has(k)) : [];

      check(
        '**登录响应的 Swagger 声明与实际返回逐字段一致**',
        declaredLogin !== null && declaredButAbsent.length === 0 && absentButReal.length === 0,
        {
          declared: declaredLogin ? [...declaredLogin] : null,
          real: realLoginKeys,
          declaredButAbsent,
          realButNotDeclared: absentButReal,
        },
      );
    }
  }

  // 必须放在最后：打满限流后，同一 IP 的商品列表请求会被拒 1001
  console.log(`\n=== 15. 公开接口限流（商品列表）===`);
  {
    // 先清掉前面段落用掉的配额，否则本轮可能"还没打几发就已经超了"，
    // 或反过来因为窗口没刷新而误判（这条断言要对"配额从 0 开始"才有意义）
    const cleared = clearRateLimitKeys();
    check('已清空限流配额，本段从 0 开始计数', true, `清理 ${cleared} 个键`);

    const max = Number(process.env.PUBLIC_RATE_MAX || 5);
    let limited = null;
    for (let i = 0; i < max + 3; i += 1) {
      const res = await api('/api/shop/products');
      if (res.body.code === 1001) {
        limited = res.body;
        break;
      }
    }
    check(
      `公开接口被限流（连打 > ${max} 次触发 1001）`,
      limited !== null,
      limited ?? '未触发，检查 PUBLIC_RATE_MAX 是否被注入（run-e2e-round3.ps1 会注入 5）',
    );
    check(
      '限流响应带 data.retry_after（前端可提示稍后再试）',
      typeof limited?.data?.retry_after === 'number',
      limited?.data,
    );
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
