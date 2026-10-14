/**
 * 生成门户 JWT 的 RS256 密钥对（契约 §0.3 / §1.5）。
 *
 * 用法：
 *   npm run keys:generate                 # 写入 keys/ 目录（生产推荐）
 *   npm run keys:generate -- --inline     # 打印为 .env 可用的内联 PEM
 *   npm run keys:generate -- --kid portal-2026-11
 *
 * 注意：
 * - `keys/` 已在 .gitignore 中，**私钥永远不要提交或写入任何文档**。
 * - 轮换时：新密钥设为当前（JWT_KID / JWT_PRIVATE_KEY_FILE / JWT_PUBLIC_KEY_FILE），
 *   旧公钥挂到 JWT_PREVIOUS_n_KID / JWT_PREVIOUS_n_PUBLIC_KEY_FILE，等旧 token 全部过期后再摘除。
 * - 产品侧通过 `/.well-known/jwks.json` 取公钥并缓存 12h，kid 不匹配时立即强刷。
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);

function argOf(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

const kid = argOf('kid', `portal-${new Date().toISOString().slice(0, 7)}`);
const inline = args.includes('--inline');
const outDir = resolve(process.cwd(), argOf('out', 'keys'));

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

if (inline) {
  const escaped = (pem: string): string => pem.trim().replace(/\n/g, '\\n');
  console.log('# 复制进 .env（仅限本地开发；生产用 *_FILE 挂载）');
  console.log(`JWT_KID=${kid}`);
  console.log(`JWT_PRIVATE_KEY=${escaped(privateKey as unknown as string)}`);
  console.log(`JWT_PUBLIC_KEY=${escaped(publicKey)}`);
} else {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'jwt-private.pem'), privateKey as unknown as string, { mode: 0o600 });
  writeFileSync(resolve(outDir, 'jwt-public.pem'), publicKey, { mode: 0o600 });
  console.log(`[keys] 已写入 ${outDir}`);
  console.log(`[keys] kid=${kid}`);
  console.log('[keys] .env 配置：');
  console.log(`JWT_KID=${kid}`);
  console.log(`JWT_PRIVATE_KEY_FILE=${resolve(outDir, 'jwt-private.pem')}`);
  console.log(`JWT_PUBLIC_KEY_FILE=${resolve(outDir, 'jwt-public.pem')}`);
}
