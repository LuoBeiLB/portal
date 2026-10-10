/**
 * 自验脚本共用的「管理员登录」helper。
 *
 * 2026-10-10 起管理端不再用静态 `X-Admin-Key`，改为**管理员账号 + JWT**：
 * 管理员就是 `role='admin'` 的普通用户，用同一个 `/api/auth/login` 登录。
 * 各 e2e 脚本原先直接塞 `x-admin-key` 头，现在统一改成带 Bearer token。
 *
 * 账号来源：`.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（启动时由环境变量 bootstrap）。
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Portal2026Admin';

/**
 * 登录管理员，返回 `{ token, id, username }`。
 * 失败直接抛错：自验脚本里管理端不可用属于环境问题，不该静默跳过。
 */
async function loginAdmin(baseUrl) {
  const base = (baseUrl || process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  const body = await response.json().catch(() => null);

  if (body?.code !== 0 || !body?.data?.access_token) {
    throw new Error(
      `管理员登录失败（${ADMIN_USERNAME}）：code=${body?.code} message=${body?.message}。` +
        '请确认 .env 的 ADMIN_USERNAME / ADMIN_PASSWORD 与服务端一致，且服务已启动过（bootstrap 会创建账号）',
    );
  }

  return {
    token: body.data.access_token,
    id: body.data.user?.id ?? body.data.id,
    username: ADMIN_USERNAME,
  };
}

/** 便捷：直接取 `Authorization` 头对象 */
async function adminAuthHeader(baseUrl) {
  const { token } = await loginAdmin(baseUrl);
  return { authorization: `Bearer ${token}` };
}

/**
 * 清理限流计数（仅用于自验前置）。
 *
 * 为什么需要：`rl:shop-products:<ip>` 在 Redis 里有 60s TTL，**跨 run 有效**。
 * 上一轮 e2e 为验证限流会把配额打满，紧接着重跑就会在"公开访问"断言上被拒 1001
 * —— 表现像功能坏了，其实是限流残留。这里在跑断言前把这个前缀的键删掉。
 *
 * 只在自验脚本里调用，**绝不在应用代码里**做这种清空。
 * 用工作区自带的 `redis-cli`（`.tools/redis/`），避免为自验引入 Redis 客户端依赖。
 */
function clearRateLimitKeys() {
  const { execFileSync } = require('node:child_process');
  const { join } = require('node:path');

  const cli = join(process.cwd(), '..', '..', '.tools', 'redis', 'redis-cli.exe');
  const port = String(process.env.REDIS_PORT || 6379);
  const prefix = process.env.REDIS_KEY_PREFIX || 'portal:';
  const run = (args) => execFileSync(cli, ['-p', port, ...args], { encoding: 'utf8', timeout: 5000 });

  try {
    // 用 KEYS 而不是 --scan：两者都会返回原始键名（不含 keyPrefix），
    // 但 --scan 是游标遍历，输出解析在 Windows 换行上更容易出错；自验库键量很小，KEYS 足够。
    const raw = run(['keys', `${prefix}rl:*`]);
    const keys = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (keys.length === 0) return 0;

    // 逐个 DEL：键名里可能含空格等字符，走数组参数最稳
    for (const key of keys) run(['DEL', key]);
    return keys.length;
  } catch {
    // Redis 没起或 cli 不存在：不该让自验直接炸，后续断言会自然暴露问题
    return 0;
  }
}

module.exports = { loginAdmin, adminAuthHeader, clearRateLimitKeys, ADMIN_USERNAME, ADMIN_PASSWORD };
