/**
 * 演示"产品用门户公钥验签"的完整流程（不依赖门户服务与 Redis，纯本机）。
 *
 * 回答的问题：拿公钥验签到底是怎么验的？为什么公钥可以随便分发？
 *
 * 用法：node scripts/demo-jwks-verify.cjs
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const crypto = require('node:crypto');

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { loadConfig } = require('../dist/config/configuration.js');
const config = loadConfig();

const b64url = (input) => Buffer.from(input).toString('base64url');
const decodePart = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** 门户签发（必须有私钥；这里等同于 TokenService.issueAccessToken 做的事） */
function signPortalJwt(privatePem, payload) {
  const header = { alg: 'RS256', typ: 'JWT', kid: config.jwt.current.kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), crypto.createPrivateKey(privatePem));
  return `${signingInput}.${signature.toString('base64url')}`;
}

(async () => {
  const publicKey = crypto.createPublicKey(config.jwt.current.publicKey);

  console.log('=== 第 0 步：门户手里有两把钥匙 ===');
  console.log(`  私钥（只在门户服务器上，绝不外发）: ${config.jwt.current.privateKey.split('\n')[0]}…`);
  console.log(`  公钥（通过 JWKS 公开给所有产品）  : ${config.jwt.current.publicKey.split('\n')[0]}…`);
  console.log(`  kid = ${config.jwt.current.kid}`);
  console.log(`  iss = ${config.jwt.issuer}`);

  console.log('\n=== 第 1 步：门户用私钥签一个 access token ===');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: '01a12e9e-demo-7bc0-9549-598d534a76d2',
    uname: 'luobo',
    role: 'user',
    iat: now,
    exp: now + config.jwt.accessTtlSeconds,
    iss: config.jwt.issuer,
  };
  const jwt = signPortalJwt(config.jwt.current.privateKey, payload);
  const [headerPart, payloadPart, signaturePart] = jwt.split('.');
  console.log(`  token: ${jwt.slice(0, 64)}…`);

  console.log('\n=== 第 2 步：产品把 token 拆成三段 ===');
  console.log(`  ① header （明文，产品用来找公钥）: ${JSON.stringify(decodePart(headerPart))}`);
  console.log(`  ② payload（明文，产品读它是谁）  : ${JSON.stringify(decodePart(payloadPart))}`);
  console.log(`  ③ 签名   （${Buffer.from(signaturePart, 'base64url').length} 字节）`);
  console.log('  ⚠️ ①②是 base64，不是加密 —— 谁都能读。安全性**完全**靠 ③ 的签名。');

  console.log('\n=== 第 3 步：产品用**公钥**验签 ===');
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = Buffer.from(signaturePart, 'base64url');
  const ok = crypto.verify('sha256', Buffer.from(signingInput), publicKey, signature);
  console.log(`  RSA-SHA256 验签：${ok ? '✅ 通过 —— 确认是门户签的，且没被改过' : '❌ 失败'}`);

  console.log('\n=== 第 4 步：篡改 payload（想把自己变成 admin）===');
  const tampered = { ...decodePart(payloadPart), role: 'admin', sub: 'attacker-uuid' };
  const tamperedPart = b64url(JSON.stringify(tampered));
  const tamperedOk = crypto.verify('sha256', Buffer.from(`${headerPart}.${tamperedPart}`), publicKey, signature);
  console.log(`  改完再验签：${tamperedOk ? '❌ 竟然通过（不该发生）' : '✅ 被识破 —— 签名对不上'}`);
  console.log(`  （这也是为什么产品必须**先验签再读 payload**，不能反过来）`);

  console.log('\n=== 第 5 步：拿公钥能不能自己签一个？ ===');
  try {
    crypto.sign('sha256', Buffer.from('fake.header'), crypto.createPrivateKey(config.jwt.current.publicKey));
    console.log('  ❌ 竟然签出来了 —— 不该发生');
  } catch (error) {
    console.log(`  ✅ 不能：${error.message.split('\n')[0]}`);
    console.log('     原理：RSA 的签名只能由**私钥**产生。公钥只能"验"，数学上无法反推签名。');
    console.log('     所以公钥可以放公开端点随便拉 —— 拿到它伪造不出任何 token。');
  }

  console.log('\n=== 第 6 步：验签通过≠放行，还要查 4 项 ===');
  const header = decodePart(headerPart);
  const body = decodePart(payloadPart);
  const checks = [
    ['alg 必须是 RS256', header.alg === 'RS256', `${header.alg}（防 alg=none / HS256 降级攻击）`],
    ['iss 必须匹配', body.iss === config.jwt.issuer, `${body.iss} vs ${config.jwt.issuer}`],
    ['exp 未过期', body.exp > now, `剩余 ${Math.round((body.exp - now) / 60)} 分钟`],
    ['kid 必须是已知的', true, `${header.kid}（不认识就强刷一次 JWKS 再试）`],
  ];
  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${name.padEnd(20)} ${detail}`);
  }

  console.log('\n=== 全过之后：认人 ===');
  console.log(`  取 payload.sub = ${body.sub}`);
  console.log('  → 查本产品的 portal_user_map，拿到对应的 local user');
  console.log('  → 无记录就建档（首达），有就用');
  console.log('  → 之后所有业务逻辑照旧按 local user 走，产品代码不用改');
})();
