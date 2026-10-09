/**
 * 产品内网接口路径探测：同一 baseUrl 下把几种可能的路径都试一遍，
 * 用来定位「404 是路径拼错还是服务没这个接口」。
 *
 * 用法：node scripts/probe-product-paths.cjs
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const base = (process.env.PRODUCT_STORAGE_BASE_URL || '').replace(/\/+$/, '');
const key = process.env.PRODUCT_STORAGE_INTERNAL_KEY || '';

const candidates = [
  '/internal/products',        // base 直接是内网服务（无 context-path）
  '/api/internal/products',    // 服务 context-path=/api
  '/api/api/internal/products', // 双前缀（我曾踩过的坑）
  '/products',
  '/api/products',
];

(async () => {
  console.log(`base = ${base}\n`);
  for (const path of candidates) {
    const url = `${base}${path}`;
    let line = `  ${path.padEnd(30)} `;
    try {
      const response = await fetch(url, {
        headers: key ? { 'x-internal-key': key } : {},
        signal: AbortSignal.timeout(8000),
      });
      const text = await response.text();
      let code = '';
      try {
        code = ` code=${JSON.parse(text)?.code}`;
      } catch {
        code = text.includes('tomcat') || text.includes('Tomcat') ? ' (Tomcat 错误页)' : ' (非 JSON)';
      }
      line += `HTTP ${response.status}${code}`;
      if (response.status === 200) line += '   ← ✓ 就是这个';
    } catch (error) {
      line += `连不上：${error.cause?.code ?? error.name}`;
    }
    console.log(line);
  }
  console.log('\n判读：');
  console.log('  200 + code=0            → 用这个路径，把它填进 .env 的 PRODUCT_STORAGE_BASE_URL 前缀部分');
  console.log('  401 + code=40001        → 路径对，但密钥不匹配');
  console.log('  401 + code=40103        → 路径对，但掉进登录链（他们的过滤链问题）');
  console.log('  404 (Tomcat 错误页)      → 路径不对，或服务根本没部署这个接口');
})();
