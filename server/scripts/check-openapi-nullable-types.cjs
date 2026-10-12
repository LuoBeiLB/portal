/**
 * 检查 OpenAPI 里的**字段类型标注**是否可信（长期自检工具）。
 *
 * 背景：TS 反射对 `string | null` 这类联合类型推不出来，会退化成 `Object`，
 * NestJS 于是写出 `{"type":"object"}`。纯 JS 前端不受影响，但**任何按 OpenAPI
 * 生成类型的工具（管理端 / 产品端）会生成错类型** —— 2026-10-10 被前端 D 组提过。
 * 当时实测有 33 个字段中招（name / instance_id / expire_at / fail_reason / paid_at / phone 等）。
 *
 * 判据：声明为 `object` 的字段必须有明确结构（`$ref` / `properties` / `additionalProperties`）
 * 三者之一；三者皆无 → 说明是反射没推出来的联合类型，属于**标错**。
 *
 * 用法（服务在跑）：node scripts/check-openapi-nullable-types.cjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

(async () => {
  const doc = await (await fetch(`${BASE}/api/docs-json`)).json();
  const schemas = doc.components?.schemas ?? {};

  const suspects = [];
  for (const [name, schema] of Object.entries(schemas)) {
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (prop.type !== 'object') continue;
      if (prop.$ref || prop.properties || prop.additionalProperties) continue;
      suspects.push(`${name}.${key}${prop.nullable ? '（nullable）' : ''}`);
    }
  }

  console.log(`扫描 ${Object.keys(schemas).length} 个 schema`);
  console.log(`\n声明为 object 但**没有结构**（疑似标错的 nullable 标量）：${suspects.length} 个`);
  if (suspects.length === 0) {
    console.log('  ✓ 无（自由结构对象都已带 additionalProperties）');
  } else {
    for (const s of suspects) console.log(`  ✗ ${s}`);
    console.log('\n修复办法：给对应的 @ApiProperty 补 type: String / Number / Boolean，');
    console.log('自由结构对象补 type: "object", additionalProperties: true。');
  }

  process.exit(suspects.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error('失败：', error.message);
  process.exit(2);
});
