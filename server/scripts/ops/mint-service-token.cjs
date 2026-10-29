#!/usr/bin/env node
/**
 * 手工签发**出站**服务凭据（门户 → 产品），用于 Apifox / curl 联调（docs/27 §3.2）。
 *
 * 正常业务路径上，这个 token 由 `ProductClient` 在调产品前自动签（`ServiceTokenService`）。
 * 本脚本只是把那一步单独拿出来，方便你手动打产品侧的内网接口 —— 比如验证云手机有没有
 * 正确实现 `htm`/`htu`/`qs`/`body_sha256`/`jti` 那些校验。
 *
 * 用法（在 portal/server 下）：
 *
 *   # GET（无 query）
 *   node scripts/ops/mint-service-token.cjs --product phone --path /api/internal/products
 *
 *   # GET（带 query，qs 会被规范化后签进去）
 *   node scripts/ops/mint-service-token.cjs --product phone \
 *     --path /api/internal/enterprise-accounts --query 'enterprise_id=3&keyword=li'
 *
 *   # POST（body 必须**一字不差**地用脚本打印出来的那份）
 *   node scripts/ops/mint-service-token.cjs --product phone \
 *     --method POST --path /api/internal/provision \
 *     --body '{"order_item_id":"281","portal_user_id":"01a1...","sku_id":"phone-1c2g","quantity":1,"period_hours":720}'
 *
 * 关键限制（不读会白试）：
 *
 * 1. **有效期 60 秒**，且 `jti` 一次性 —— 同一 token 发第二次会被对方判重放（`1002`）。
 *    所以每试一次就得重新跑一次本脚本；或用 `--count 3` 一次打 3 个备用。
 * 2. **`body_sha256` 是按你传进来的 `--body` 原文算的**。粘到 Apifox 里必须一个字节都不改
 *    （不要格式化、不要加空格），否则对方算出来对不上 → `1002`。
 *    最稳的做法是直接用脚本打印的 curl 命令（--data-raw 引的是同一份文本）。
 * 3. `--path` 写**实际路径**（含 `/api` 前缀），签名时会自动剥掉 —— 对方校验的 `htu` 不含 `/api`。
 */

const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const { sign } = require('jsonwebtoken');

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const TTL_DEFAULT = 60;

function usage() {
  console.log(
    [
      '用法：',
      '  node scripts/ops/mint-service-token.cjs --product <code> --path </api/...>',
      '      [--method GET|POST|...] [--query <裸query串>] [--body <原样JSON文本>]',
      '      [--ttl 60] [--count 1] [--base-url http://host:port/api]',
      '',
      '说明：',
      '  --path       实际路径，含 /api 前缀（签名时自动剥掉）',
      '  --body       与将要发送的 body **完全一致**的文本（不要换行/缩进）',
      '  --count      一次打印多个 token（每个 jti 不同，用于连续试几次）',
      '  --base-url   只影响打印出来的 curl 示例，不参与签名',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`无法识别的参数：${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 缺少取值`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

/** 与门户验签、产品验签同一套规范化（docs/27 §3.3） */
function stripApiPrefix(path) {
  return path.replace(/^\/api(?=\/)/, '');
}
function canonicalQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams(query);
  return [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}
function bodySha256(text) {
  if (!text) return undefined;
  return require('node:crypto').createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help')) {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const flags = parseArgs(argv);

  const product = (flags.product ?? '').trim();
  const method = (flags.method ?? 'GET').toUpperCase();
  const path = (flags.path ?? '').trim();
  if (!product) throw new Error('缺少 --product（storage / phone / desktop）');
  if (!path) throw new Error('缺少 --path（如 /api/internal/products）');

  const privateKeyFile = process.env.JWT_PRIVATE_KEY_FILE;
  if (!privateKeyFile) throw new Error('缺少 JWT_PRIVATE_KEY_FILE（约定在 portal/server/.env）');
  const privateKey = readFileSync(resolve(privateKeyFile), 'utf8');

  const kid = process.env.JWT_KID;
  const issuer = process.env.JWT_ISSUER ?? 'cloud-portal';
  if (!kid) throw new Error('缺少 JWT_KID');

  const ttl = Number(flags.ttl ?? TTL_DEFAULT);
  const count = Math.max(1, Number(flags.count ?? 1));
  const htu = stripApiPrefix(path);
  const qs = canonicalQuery(flags.query ?? '');
  const bodyText = flags.body;
  const hash = bodySha256(bodyText);
  const baseUrl = (flags['base-url'] ?? '').replace(/\/+$/, '');

  console.log(`  kid=${kid}  iss=${issuer}  aud=${product}`);
  console.log(`  htm=${method}  htu=${htu}`);
  console.log(`  qs=${JSON.stringify(qs)}${hash ? `  body_sha256=${hash}` : ''}`);
  console.log(`  有效期=${ttl}s  （jti 一次性，同一 token 重发会被判重放）`);
  console.log('');

  for (let i = 1; i <= count; i += 1) {
    const now = Math.floor(Date.now() / 1000);
    const token = sign(
      {
        aud: product,
        htm: method,
        htu,
        qs,
        ...(hash ? { body_sha256: hash } : {}),
        iat: now,
        exp: now + ttl,
        jti: randomBytes(16).toString('hex'),
      },
      privateKey,
      { algorithm: 'RS256', keyid: kid, issuer },
    );

    if (count > 1) console.log(`  ── #${i} ────────────────────────────────────────`);
    console.log(`  Authorization: Bearer ${token}`);
    if (baseUrl) {
      const url = `${baseUrl}${htu}${qs ? `?${qs}` : ''}`;
      if (method === 'GET') {
        console.log(`  curl -X GET '${url}' -H 'Authorization: Bearer ${token}'`);
      } else {
        console.log(
          `  curl -X ${method} '${url}' -H 'Authorization: Bearer ${token}' ` +
            `-H 'content-type: application/json' --data-raw '${bodyText ?? ''}'`,
        );
      }
    }
    console.log('');
  }

  console.log('  用法提示：');
  console.log('   · Apifox：Auth 选 Bearer，把上面整串（不含 "Authorization: Bearer " 前缀）粘进去');
  console.log('   · 每次重发前请重新生成 —— 40 秒前生成的那张可能已经过期，重复用同一张会被判重放');
  if (bodyText) {
    console.log('   · POST 的 body 必须与 --body 完全一致（脚本已按这份原文算 hash）');
  }
}

try {
  main();
} catch (error) {
  console.error(`✗ ${error.message}`);
  console.error('');
  usage();
  process.exit(1);
}
