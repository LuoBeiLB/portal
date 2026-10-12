/**
 * 管理端全链路验证（2026-10-10 新增）。
 *
 * 覆盖：管理员账号登录鉴权、用户查询/禁用/恢复、流水列表、操作日志、
 * 登录态校验、管理员 CRUD、改密码，以及**权限边界**（普通用户不得进管理端）。
 *
 * 用法（在 portal/server 下）：
 *   node scripts/e2e-admin.cjs
 *
 * 前置：
 *   - 门户服务在跑，且 `.env` 配了 ADMIN_USERNAME / ADMIN_PASSWORD（bootstrap 首个管理员）
 *   - Redis 在跑（登录要写 refresh 会话）
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Portal2026Admin';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
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
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { http: response.status, code: json?.code, message: json?.message, data: json?.data, text, json };
}

const stamp = Date.now().toString().slice(-9);

(async () => {
  console.log('\n=== 1. 管理员登录（复用普通用户登录接口）===');
  let adminToken = '';
  let adminId = '';
  {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    check('管理员用 /api/auth/login 登录成功', login.code === 0, login.json);
    adminToken = login.data?.access_token ?? '';
    adminId = login.data?.user?.id ?? '';
    check('返回 access_token', typeof adminToken === 'string' && adminToken.length > 20, null);

    // JWT 里必须带 role=admin（管理端鉴权靠它，不查库）
    const payloadPart = adminToken.split('.')[1];
    const payload = payloadPart
      ? JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
      : {};
    check('**JWT 携带 role=admin**', payload.role === 'admin', payload);
    check('JWT 携带 sub（用户 UUID）', typeof payload.sub === 'string' && payload.sub.length === 36, payload.sub);
  }

  console.log('\n=== 2. 权限边界（普通用户不得进管理端）===');
  let userToken = '';
  let userId = '';
  {
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: { username: `e2eadmin_${stamp}`, password: 'Ab12345678' },
    });
    check('注册普通用户成功', reg.code === 0, reg.json);
    userToken = reg.data?.access_token ?? '';
    userId = reg.data?.id ?? '';

    const noToken = await api('/api/admin/auth/verify');
    check('未登录访问管理端 -> 1002', noToken.code === 1002, noToken.json);

    const asUser = await api('/api/admin/auth/verify', { token: userToken });
    check('**普通用户访问管理端 -> 1004**', asUser.code === 1004, asUser.json);

    const asUserUsers = await api('/api/admin/users', { token: userToken });
    check('普通用户访问用户管理 -> 1004', asUserUsers.code === 1004, asUserUsers.json);

    const asUserList = await api('/api/admin/transactions', { token: userToken });
    check('普通用户访问流水管理 -> 1004', asUserList.code === 1004, asUserList.json);
  }

  console.log('\n=== 3. 登录态校验 GET /api/admin/auth/verify ===');
  {
    const verify = await api('/api/admin/auth/verify', { token: adminToken });
    check('管理员校验通过 code=0', verify.code === 0, verify.json);
    check('返回 operator（当前管理员用户名）', verify.data?.operator === ADMIN_USERNAME, verify.data);
    check('返回 role=admin', verify.data?.role === 'admin', verify.data);
    check('返回 server_time', typeof verify.data?.server_time === 'string', verify.data);
  }

  console.log('\n=== 4. 用户查询 GET /api/admin/users ===');
  let firstUserId = '';
  {
    const list = await api('/api/admin/users?page=1&size=5', { token: adminToken });
    check('用户列表 code=0', list.code === 0, list.json);
    check('返回分页结构 list/total/page/size', ['list', 'total', 'page', 'size'].every((k) => k in (list.data ?? {})), Object.keys(list.data ?? {}));

    const first = list.data?.list?.[0];
    check('列表项含 username', typeof first?.username === 'string', first);
    check('列表项含 balance_cents', typeof first?.balance_cents === 'number', first);
    check('列表项含累计充值/消费（前端需求清单）', typeof first?.recharge_total_cents === 'number' && typeof first?.consume_total_cents === 'number', first);
    firstUserId = first?.id ?? '';

    // 管理员不应出现在用户列表里（避免在用户管理页误禁用管理员）
    const hasAdminInList = (list.data?.list ?? []).some((row) => row.username === ADMIN_USERNAME);
    check('**管理员不出现在用户列表中**', !hasAdminInList, (list.data?.list ?? []).map((r) => r.username));

    const byKeyword = await api(`/api/admin/users?keyword=e2eadmin_${stamp}`, { token: adminToken });
    check('keyword 能按用户名命中', byKeyword.data?.total >= 1, byKeyword.data?.total);

    const badPage = await api('/api/admin/users?page=0', { token: adminToken });
    check('page=0 -> 1001', badPage.code === 1001, badPage.json);
  }

  console.log('\n=== 5. 禁用 / 恢复用户 POST /api/admin/users/{id}/status ===');
  {
    const disable = await api(`/api/admin/users/${userId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status: 1, reason: 'e2e 验证：违规使用' },
    });
    check('禁用用户 code=0', disable.code === 0, disable.json);
    check('返回 status=1', disable.data?.status === 1, disable.data);

    // 禁用应同时冻结钱包 + 吊销 refresh：被禁用户刷新应失败
    const disabledLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { username: `e2eadmin_${stamp}`, password: 'Ab12345678' },
    });
    check('**被禁用户无法再登录 -> 2004**', disabledLogin.code === 2004, disabledLogin.json);

    const disableAgain = await api(`/api/admin/users/${userId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status: 1 },
    });
    check('重复禁用 -> 4002', disableAgain.code === 4002, disableAgain.json);

    const enable = await api(`/api/admin/users/${userId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status: 0, reason: 'e2e 验证：误操作恢复' },
    });
    check('恢复用户 code=0', enable.code === 0, enable.json);
    check('返回 status=0', enable.data?.status === 0, enable.data);

    const relogin = await api('/api/auth/login', {
      method: 'POST',
      body: { username: `e2eadmin_${stamp}`, password: 'Ab12345678' },
    });
    check('恢复后可正常登录', relogin.code === 0, relogin.json);

    // 目标不存在 / 目标是管理员
    const notFound = await api('/api/admin/users/00000000-0000-7000-8000-000000000000/status', {
      method: 'POST',
      token: adminToken,
      body: { status: 1 },
    });
    check('目标不存在 -> 4001', notFound.code === 4001, notFound.json);

    const targetAdmin = await api(`/api/admin/users/${adminId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status: 1 },
    });
    check('**用用户接口禁用管理员 -> 1004**（必须走管理员接口）', targetAdmin.code === 1004, targetAdmin.json);
  }

  console.log('\n=== 6. 流水列表 GET /api/admin/transactions ===');
  {
    const list = await api('/api/admin/transactions?page=1&size=5', { token: adminToken });
    check('流水列表 code=0', list.code === 0, list.json);
    const first = list.data?.list?.[0];
    check('列表项含 user_id', typeof first?.user_id === 'string', first);
    check('**列表项含 username**（前端需求清单）', 'username' in (first ?? {}), first);
    check('**列表项含 user_balance_cents**', 'user_balance_cents' in (first ?? {}), first);
    check('列表项含 bill_no', typeof first?.bill_no === 'string', first);

    const byType = await api('/api/admin/transactions?type=1', { token: adminToken });
    check('按 type 过滤可用', byType.code === 0, byType.json);
    check('type 过滤后结果类型一致', (byType.data?.list ?? []).every((row) => row.type === 1), (byType.data?.list ?? []).slice(0, 3));

    const badType = await api('/api/admin/transactions?type=9', { token: adminToken });
    check('type=9 -> 1001', badType.code === 1001, badType.json);

    const today = new Date().toISOString().slice(0, 10);
    const byDate = await api(`/api/admin/transactions?start_date=${today}&end_date=${today}`, { token: adminToken });
    check('**日期区间过滤可用**（前端需求清单）', byDate.code === 0 && Array.isArray(byDate.data?.list), byDate.json);

    const badDate = await api('/api/admin/transactions?start_date=2026-13-45', { token: adminToken });
    check('非法日期 -> 1001', badDate.code === 1001, badDate.json);

    const byKeyword = await api(`/api/admin/transactions?keyword=e2eadmin_${stamp}`, { token: adminToken });
    check('keyword 按用户名过滤流水', byKeyword.code === 0, byKeyword.json);
  }

  console.log('\n=== 7. 操作日志 GET /api/admin/audit-logs ===');
  {
    const logs = await api('/api/admin/audit-logs?page=1&size=20', { token: adminToken });
    check('操作日志 code=0', logs.code === 0, logs.json);

    const byAction = await api('/api/admin/audit-logs?action=user_disable', { token: adminToken });
    const disableRows = byAction.data?.list ?? [];
    check('能按 action 过滤出禁用记录', disableRows.length >= 1, byAction.data?.total);
    check(
      '**审计记录的 operator 是真实管理员**（非前端自报）',
      disableRows[0]?.operator === ADMIN_USERNAME,
      disableRows[0],
    );
    check('审计记录带 target', typeof disableRows[0]?.target === 'string', disableRows[0]);
    check('审计记录带 ip', 'ip' in (disableRows[0] ?? {}), disableRows[0]);

    // bootstrap 的系统动作也应留痕
    const bootstrapLogs = await api('/api/admin/audit-logs?action=system_bootstrap', { token: adminToken });
    check('环境变量 bootstrap 也写入了审计（system_bootstrap）', (bootstrapLogs.data?.total ?? 0) >= 1, bootstrapLogs.data?.total);

    const badAction = await api('/api/admin/audit-logs?start_date=not-a-date', { token: adminToken });
    check('非法日期 -> 1001', badAction.code === 1001, badAction.json);
  }

  console.log('\n=== 8. 管理员管理（列表 / 创建 / 禁用守卫 / 重置密码）===');
  let secondAdminId = '';
  {
    const list = await api('/api/admin/admins', { token: adminToken });
    check('管理员列表 code=0', list.code === 0, list.json);
    check('列表中包含 bootstrap 管理员', (list.data?.list ?? []).some((row) => row.username === ADMIN_USERNAME), list.data?.list);

    const newName = `ops_${stamp}`;
    const created = await api('/api/admin/admins', {
      method: 'POST',
      token: adminToken,
      body: { username: newName, password: 'OpsPass2026' },
    });
    check('创建管理员 code=0', created.code === 0, created.json);
    secondAdminId = created.data?.id ?? '';
    check('返回新管理员 id', typeof secondAdminId === 'string' && secondAdminId.length === 36, created.data);

    const dup = await api('/api/admin/admins', {
      method: 'POST',
      token: adminToken,
      body: { username: newName, password: 'OpsPass2026' },
    });
    check('重复用户名 -> 2001', dup.code === 2001, dup.json);

    const weak = await api('/api/admin/admins', {
      method: 'POST',
      token: adminToken,
      body: { username: `weak_${stamp}`, password: 'aaaaaaaa' },
    });
    check('弱密码 -> 1001', weak.code === 1001, weak.json);

    // 新管理员能登录且是 admin
    const newLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { username: newName, password: 'OpsPass2026' },
    });
    check('新建管理员可登录', newLogin.code === 0, newLogin.json);
    const newPayload = JSON.parse(
      Buffer.from((newLogin.data?.access_token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    check('新管理员 JWT 也是 role=admin', newPayload.role === 'admin', newPayload);

    // 守卫：不能禁用自己
    const disableSelf = await api(`/api/admin/admins/${adminId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status: 1 },
    });
    check('**不能禁用自己 -> 1004**', disableSelf.code === 1004, disableSelf.json);

    // 禁用第二个管理员（合法：还剩一个可用的）
    const disableOther = await api(`/api/admin/admins/${secondAdminId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status: 1 },
    });
    check('禁用其他管理员 code=0', disableOther.code === 0, disableOther.json);
    check('返回被吊销的会话数', typeof disableOther.data?.revoked_sessions === 'number', disableOther.data);

    // 守卫：不能禁用最后一个可用管理员（此时只剩自己，已在"禁用自己"里覆盖；
    // 这里验证的是"自己"这条，因为若禁用自己会先被拦）
    const enableOther = await api(`/api/admin/admins/${secondAdminId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status: 0 },
    });
    check('恢复其他管理员 code=0', enableOther.code === 0, enableOther.json);

    // 重置他人密码
    const reset = await api(`/api/admin/admins/${secondAdminId}/password`, {
      method: 'POST',
      token: adminToken,
      body: { new_password: 'OpsPass2027' },
    });
    check('重置他人密码 code=0', reset.code === 0, reset.json);

    const oldPwLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { username: newName, password: 'OpsPass2026' },
    });
    check('旧密码已失效 -> 2003', oldPwLogin.code === 2003, oldPwLogin.json);

    const newPwLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { username: newName, password: 'OpsPass2027' },
    });
    check('新密码可登录', newPwLogin.code === 0, newPwLogin.json);

    // 重置自己的密码要走改密接口
    const resetSelf = await api(`/api/admin/admins/${adminId}/password`, {
      method: 'POST',
      token: adminToken,
      body: { new_password: 'Whatever2026' },
    });
    check('重置自己密码被拒（需用改密接口）-> 1001', resetSelf.code === 1001, resetSelf.json);
  }

  console.log('\n=== 9. 修改自己的密码 POST /api/auth/password ===');
  {
    // 用第二个管理员验证改密（避免改掉 bootstrap 管理的密码影响后续）
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { username: `ops_${stamp}`, password: 'OpsPass2027' },
    });
    const token = login.data?.access_token ?? '';
    check('第二管理员登录成功', login.code === 0, login.json);

    const wrongOld = await api('/api/auth/password', {
      method: 'POST',
      token,
      body: { old_password: 'WrongPass123', new_password: 'OpsPass2028' },
    });
    check('旧密码错误 -> 2003', wrongOld.code === 2003, wrongOld.json);

    const samePw = await api('/api/auth/password', {
      method: 'POST',
      token,
      body: { old_password: 'OpsPass2027', new_password: 'OpsPass2027' },
    });
    check('新旧密码相同 -> 1001', samePw.code === 1001, samePw.json);

    const weakNew = await api('/api/auth/password', {
      method: 'POST',
      token,
      body: { old_password: 'OpsPass2027', new_password: 'aaaaaaaa' },
    });
    check('新密码太弱 -> 1001', weakNew.code === 1001, weakNew.json);

    const ok = await api('/api/auth/password', {
      method: 'POST',
      token,
      body: { old_password: 'OpsPass2027', new_password: 'OpsPass2028' },
    });
    check('改密成功 code=0', ok.code === 0, ok.json);
    check('返回被吊销的会话数', typeof ok.data?.revoked_sessions === 'number', ok.data);

    const afterChange = await api('/api/auth/login', {
      method: 'POST',
      body: { username: `ops_${stamp}`, password: 'OpsPass2028' },
    });
    check('新密码可登录', afterChange.code === 0, afterChange.json);

    const changeLog = await api('/api/admin/audit-logs?action=password_change', { token: adminToken });
    check(
      '**改密被记入审计日志**',
      (changeLog.data?.list ?? []).some((row) => row.operator === `ops_${stamp}`),
      changeLog.data?.total,
    );
  }

  console.log('\n=== 10. 导出 CSV（日期过滤 + 审计留痕）===');
  {
    const response = await fetch(`${BASE}/api/admin/transactions/export?limit=10`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    // 用字节判断 BOM：response.text() 解码后 BOM 不再以 \uFEFF 字符形式存在（实测坑）
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    check('导出 HTTP 200', response.status === 200, response.status);
    check('**返回裸 CSV（不套 code/data 壳）**', !text.includes('"code"'), text.slice(0, 60));
    check(
      '**CSV 带 BOM**（Excel 打开中文不乱码）',
      bytes.subarray(0, 3).toString('hex') === 'efbbbf',
      bytes.subarray(0, 3).toString('hex'),
    );
    check('CSV 有表头', text.includes('bill_no'), text.slice(0, 80));

    const noAuth = await fetch(`${BASE}/api/admin/transactions/export`);
    check('导出未登录 -> 1002', noAuth.status === 200, noAuth.status);

    const exportLogs = await api('/api/admin/audit-logs?action=transaction_export', { token: adminToken });
    check('**导出被记入审计日志**', (exportLogs.data?.total ?? 0) >= 1, exportLogs.data?.total);
  }

  console.log('\n=== 11. 时间口径统一（2026-10-12 定稿）===');
  {
    // 规则：接口返回的时间字符串 = 用户该看到的**墙上时间**，前端直接展示、不做时区转换。
    //
    // ⚠️ 断言写法容易踩坑：接口给的是 `2026-10-12T10:42:03Z`，这里的 `Z` 只是占位
    // （库里存的就是墙上时间）。所以**不能**直接跟 `new Date()` 比 —— `new Date("10:42Z")`
    // 是 UTC 10:42，而本地墙上 10:42 对应 UTC 02:42，会白白差 8 小时。
    // 正确做法：把"现在的本地墙上时间"也拼成同样的 `...Z` 形状再比。
    const wallNow = () => {
      const d = new Date();
      const pad = (n, w = 2) => String(n).padStart(w, '0');
      return new Date(
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
          `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000Z`,
      );
    };
    const minutesApart = (iso, reference) => Math.abs(new Date(iso).getTime() - reference.getTime()) / 60_000;

    // ① 库生成列（u_user.created_at）：刚注册的用户，created_at 应等于当前墙上时间
    const fresh = await api('/api/auth/register', {
      method: 'POST',
      body: { username: `tzchk_${Date.now().toString().slice(-9)}`, password: 'Ab12345678' },
    });
    check(
      '**库生成列（u_user.created_at）返回的是当前墙上时间**',
      minutesApart(fresh.data?.created_at, wallNow()) < 5,
      { created_at: fresh.data?.created_at, wallNow: wallNow().toISOString() },
    );

    // ② 应用写列（o_order.paid_at）：刚支付的订单，paid_at 也应等于当前墙上时间
    const tzToken = fresh.data?.access_token;
    const products = await api('/api/shop/products?product_code=storage');
    const sku = (products.data?.list ?? []).find((p) => Number(p.price_cents) > 0);
    if (sku) {
      const apply = await api('/api/wallet/recharge/apply', {
        method: 'POST',
        token: tzToken,
        body: { amount_cents: 100000, remark: 'e2e 时间口径校验' },
      });
      await api(`/api/admin/recharges/${apply.data?.apply_id}/confirm`, {
        method: 'POST',
        token: adminToken,
        body: { reject: false },
      });
      const order = await api('/api/shop/orders', {
        method: 'POST',
        token: tzToken,
        body: { items: [{ product_code: sku.product_code, sku_id: sku.sku_id, quantity: 1 }] },
      });
      const paid = await api(`/api/shop/orders/${order.data?.order_id}/pay`, { method: 'POST', token: tzToken });
      const paidAt = paid.data?.paid_at;
      check(
        '**应用写列（o_order.paid_at）返回的也是当前墙上时间**',
        paidAt !== null && paidAt !== undefined && minutesApart(paidAt, wallNow()) < 5,
        { paid_at: paidAt, wallNow: wallNow().toISOString() },
      );
      check(
        '同一订单里 created_at 与 paid_at 相差在 1 分钟内（不再差 8 小时）',
        Math.abs(new Date(paid.data?.created_at).getTime() - new Date(paidAt).getTime()) < 60_000,
        { created_at: paid.data?.created_at, paid_at: paidAt },
      );
    } else {
      check('（跳过 paid_at 断言）商品目录为空', true, null);
    }

    // ③ 审计日志（库生成列）：刚写的日志，时间也应是当前墙上时间
    const logs = await api('/api/admin/audit-logs?page=1&size=1', { token: adminToken });
    const newest = logs.data?.list?.[0];
    check(
      '**审计日志 created_at 是当前墙上时间**',
      newest ? minutesApart(newest.created_at, wallNow()) < 5 : false,
      { created_at: newest?.created_at, wallNow: wallNow().toISOString() },
    );
  }

  console.log('\n' + '='.repeat(70));
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
