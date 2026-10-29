const { existsSync, readFileSync, openSync, closeSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const { sign } = require('jsonwebtoken');
if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const PORT = 3471;
const BASE = `http://127.0.0.1:${PORT}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mine = readFileSync(resolve(process.env.JWT_PRIVATE_KEY_FILE), 'utf8');
const now = Math.floor(Date.now() / 1000);

(async () => {
  writeFileSync(resolve(process.cwd(), 'scripts/e2e/_p3.log'), '');
  const fd = openSync(resolve(process.cwd(), 'scripts/e2e/_p3.log'), 'a');
  const child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, APP_PORT: String(PORT), SWAGGER_ENABLED: 'false' },
    stdio: ['ignore', fd, fd],
  });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i += 1) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { await sleep(400); } }
    if (!up) throw new Error('未就绪');
    console.log('  服务已就绪\n');

    const call = async (label, token) => {
      const res = await fetch(`${BASE}/shop/orders/999999/pay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ portal_user_id: '01a1victim', amount_cents: 1 }),
      });
      const body = await res.json().catch(() => ({}));
      console.log('  ' + label.padEnd(36) + `HTTP ${res.status}  code=${body.code}  ${String(body.message ?? '').slice(0, 44)}`);
    };

    const temp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await call('① 产品凭据 + body 塞用户字段', sign(
      { aud: 'cloud-portal', htm: 'POST', htu: '/shop/orders/999999/pay', qs: '', iat: now, exp: now + 60, jti: randomBytes(16).toString('hex') },
      temp.privateKey, { algorithm: 'RS256', keyid: 'phone-2026-10', issuer: 'phone' },
    ));
    await call('② 随机私钥冒充门户签发', sign(
      { sub: '01a1fake', uname: 'attacker', role: 'user', ut: 0, iat: now, exp: now + 600 },
      temp.privateKey, { algorithm: 'RS256', issuer: 'cloud-portal', keyid: 'portal-2026-10' },
    ));
    await call('③ 合法用户 token + 伪造 body', sign(
      { sub: '01a1fake', uname: 'attacker', role: 'user', ut: 0, iat: now, exp: now + 600 },
      mine, { algorithm: 'RS256', issuer: 'cloud-portal', keyid: process.env.JWT_KID },
    ));
  } catch (e) {
    console.error('  异常：' + e.message);
  } finally {
    child.kill(); closeSync(fd);
  }
})();
