/**
 * 产品内网接口连通性检查（只读）。
 *
 * 用法：
 *   node scripts/probe-product-endpoint.cjs                    # 用 .env 的 PRODUCT_STORAGE_*
 *   node scripts/probe-product-endpoint.cjs http://x.x.x.x:3001 <key>
 *
 * 它做什么：按契约 §5.1 调 `GET {base}/internal/products`，并把结果分门别类，
 * 让你一眼看出失败在哪一层：协议头写错 / 网络不通 / 端口不通 / 密钥不对 / 掉进登录链 / 返回格式不符。
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const base = (process.argv[2] || process.env.PRODUCT_STORAGE_BASE_URL || '').replace(/\/+$/, '');
const key = process.argv[3] || process.env.PRODUCT_STORAGE_INTERNAL_KEY || '';

/** 复刻门户内部拼 URL 的方式，提前暴露"少协议头"这类问题 */
function diagnoseBase(value) {
  if (!value) return '地址为空（视为未接入，不同步）';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `协议头非法：解析出 protocol="${parsed.protocol}"，只支持 http/https`;
    }
    return null;
  } catch (error) {
    return `不是合法 URL（${error.message}）。最常见原因：**少了 http:// 协议头**，` +
      `例如写成 "192.168.9.115:3001"，会被当成 scheme="192.168.9.115:"`;
  }
}

(async () => {
  console.log('=== 配置 ===');
  console.log(`  base = ${base || '(空)'}`);
  console.log(`  key  = ${key ? `${key.slice(0, 8)}…（${key.length} 字符）` : '(空)'}`);

  const problem = diagnoseBase(base);
  if (problem) {
    console.log(`\n  ✗ 地址有问题：${problem}`);
    process.exit(1);
  }

  const url = `${base}/internal/products`;
  console.log('\n=== 请求 ===');
  console.log(`  GET ${url}`);
  console.log(`  X-Internal-Key: ${key ? key.slice(0, 8) + '…' : '(未带)'}`);

  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: key ? { 'x-internal-key': key } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const elapsed = Date.now() - started;
    console.log(`\n  ✗ 连不上（${elapsed}ms）：${error.cause?.code ?? error.name} ${error.message}`);
    console.log('\n  按错误码判断：');
    console.log('    ECONNREFUSED → 地址/端口对，但没有服务在听（服务没起？端口不对？）');
    console.log('    ETIMEDOUT / TimeoutError → 网络不通或防火墙拦了（本机到他们内网没有路由？）');
    console.log('    ENOTFOUND / EAI_AGAIN → 主机名解析不了（用 IP 更稳）');
    process.exit(2);
  }

  const elapsed = Date.now() - started;
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON，下面按原文展示 */
  }

  console.log(`\n=== 响应（${elapsed}ms）===`);
  console.log(`  HTTP ${response.status}`);
  console.log(`  ${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`);

  console.log('\n=== 判读 ===');
  if (response.status === 200 && body?.code === 0) {
    const products = body?.data?.products ?? [];
    console.log(`  ✓ 通了。返回 ${products.length} 个 SKU：`);
    for (const item of products.slice(0, 8)) {
      console.log(
        `      ${String(item.sku_id).padEnd(20)} ${String(item.price_cents).padStart(8)} 分` +
          `  billing_mode=${item.billing_mode}  period_days=${item.period_days ?? '-'}  stock=${item.stock ?? 'null'}`,
      );
    }
    console.log('\n  下一步：重启门户（读取新地址），等 1 分钟看是否出现「商品同步完成：1 个产品，共 upsert N 条」');
    process.exit(0);
  }

  if (response.status === 401 && body?.code === 40001) {
    console.log('  ✗ 密钥不对（40001 = X-Internal-Key 缺失或错误）');
    console.log('    核对：门户 PRODUCT_STORAGE_INTERNAL_KEY 与云存储 PORTAL_INTERNAL_KEY 必须是同一个值');
    process.exit(3);
  }
  if (body?.code === 40103) {
    console.log('  ✗ 掉进登录态过滤链了（40103 = 未带 JWT）');
    console.log('    说明云存储的 InternalKeyFilter 没接住这个请求，是他们的实现问题，不是密钥问题');
    process.exit(4);
  }
  if (response.status === 404) {
    console.log('  ✗ 路径不存在（404）');
    console.log('    最常见两个原因：');
    console.log('      ① base 少了协议头 → 但那种情况会先报 Invalid URL，不会走到这里；');
    console.log('      ② **base 没填到 context-path 为止**：云存储的 context-path=/api，');
    console.log('         完整接口是 `{host}/api/internal/products`，所以 base 要写成 `http://host:port/api`。');
    console.log('    用 node scripts/probe-product-paths.cjs 可一次性试出正确路径。');
    process.exit(5);
  }

  console.log(`  ✗ 非预期响应：HTTP ${response.status} code=${body?.code ?? '(无)'}`);
  console.log('    这不符合契约 §0.2（业务失败也应 HTTP 200 + code），把原文发给云存储侧确认');
  process.exit(6);
})().catch((error) => {
  console.error('检查失败：', error.message);
  process.exit(9);
});
