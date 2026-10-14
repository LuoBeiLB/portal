/**
 * 检查 OpenAPI 里的**响应结构**是否完整（2026-10-10）。
 *
 * 背景：C 组前端反馈 Swagger 里所有接口只有入参、没有响应结构，
 * 前端只能"实际调一次、把返回打印出来猜字段名"。
 * 本脚本遍历文档，找出「有响应体但没声明 schema」的接口。
 *
 * 用法（服务在跑时）：node scripts/check-openapi-responses.cjs [baseUrl]
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');

/** 这些接口刻意不套 {code,data} 壳，允许没有 response schema */
const RAW_RESPONSE_PATHS = new Set([
  '/.well-known/jwks.json',
  '/api/admin/transactions/export',
]);

(async () => {
  const doc = await (await fetch(`${BASE}/api/docs-json`)).json();
  const schemas = doc.components?.schemas ?? {};
  const names = Object.keys(schemas);

  console.log(`schemas 总数：${names.length}`);
  const views = names.filter((n) => /View$/.test(n));
  console.log(`响应模型（*View）：${views.length} 个 → ${views.join(', ') || '(无)'}`);

  const missing = [];
  const ok = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (RAW_RESPONSE_PATHS.has(path)) continue;
      const content = op.responses?.[200]?.content?.['application/json']?.schema;
      const ref = content?.$ref ? content.$ref.split('/').pop() : content?.type === 'array' ? 'array' : null;
      if (ref) ok.push(`${method.toUpperCase()} ${path} → ${ref}`);
      else missing.push(`${method.toUpperCase()} ${path}`);
    }
  }

  console.log(`\n已声明响应结构的接口：${ok.length} 个`);
  for (const line of ok) console.log(`  ✓ ${line}`);

  console.log(`\n仍是空响应的接口：${missing.length} 个`);
  for (const line of missing) console.log(`  ✗ ${line}`);

  // 关键模型字段抽查（防止 @ApiProperty 漏写导致 schema 空对象）
  console.log('\n关键模型字段：');
  for (const model of ['OrderView', 'OrderItemView', 'ProductView', 'TransactionView', 'MyRechargeView']) {
    const props = Object.keys(schemas[model]?.properties ?? {});
    console.log(`  ${model.padEnd(16)} ${props.length} 个字段  ${props.join(', ') || '✗ 空对象'}`);
  }

  process.exit(missing.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error('失败：', error.message);
  process.exit(2);
});
