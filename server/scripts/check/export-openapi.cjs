/**
 * 导出 OpenAPI 文档到文件（给前端/产品侧导入 Apifox、Postman、Swagger Editor 用）。
 *
 * 用法：
 *   node scripts/export-openapi.cjs            # 写到 docs/openapi.json
 *   node scripts/export-openapi.cjs out.json   # 指定输出路径
 *
 * 说明：
 * - 以 Nest 应用上下文生成，**会连一次数据库**（应用启动即校验连接），因此需先起 MySQL；
 *   但不会监听端口，脚本结束即关闭。
 * - 这个 JSON 建议**提交进仓库**：前端同事不用起后端也能导入接口文档。
 */
const { existsSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

// 先读 .env（与控制台启动一致）：否则 JWT_PRIVATE_KEY_FILE 等配置取不到，
// TokenModule 会因为"私钥未配置"直接拒绝启动。
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
// 强制开启文档生成（即使 .env 里 SWAGGER_ENABLED=false）
process.env.SWAGGER_ENABLED = 'true';

const { NestFactory } = require('@nestjs/core');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');

const { AppModule } = require('../../dist/app.module');
const { PortalConfigService } = require('../../dist/config/portal-config.service');
const { setupSwagger } = require('../../dist/config/swagger.setup');

(async () => {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.setGlobalPrefix('api', { exclude: ['.well-known/jwks.json'] });

  const config = app.get(PortalConfigService);
  setupSwagger(app, config);

  const builder = new DocumentBuilder()
    .setTitle('云平台统一门户 API（cloud-portal）')
    .setDescription(
      [
        '依据《云平台统一门户 API 契约 v1.0》（2026-09-30 定稿）实现。',
        '',
        '约定提醒：',
        '- 响应恒为 `{ code, message, data }`，HTTP 状态码基本为 200，**成功与否看 code**；',
        '- 金额一律整数「分」；时间一律 UTC ISO 8601；',
        '- 例外：`/.well-known/jwks.json` 返回标准 JWKS，`/api/admin/transactions/export` 返回 CSV，两者不套统一响应壳。',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .addApiKey({ type: 'apiKey', name: 'X-Internal-Key', in: 'header' }, 'internal-key')
    // 2026-10-10 起管理端改用管理员账号（role=admin 的 JWT），X-Admin-Key 方案已删除
    .addTag('认证 auth', '契约 §1')
    .addTag('钱包 wallet', '契约 §3')
    .addTag('内网计费 internal', '契约 §4（产品 → 门户）')
    .addTag('管理端 admin', '契约 §6')
    .addTag('商城 shop', '契约 §2（round 3）')
    .addTag('运维 ops', '探活与元信息')
    .build();

  const document = SwaggerModule.createDocument(app, builder, { deepScanRoutes: true });

  const outPath = resolve(process.cwd(), process.argv[2] || 'docs/openapi.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const pathCount = Object.keys(document.paths || {}).length;
  const schemaCount = Object.keys(document.components?.schemas || {}).length;
  console.log(`[openapi] 已导出 ${outPath}`);
  console.log(`[openapi] 接口路径 ${pathCount} 个，Schema ${schemaCount} 个`);

  await app.close();
  process.exit(0);
})().catch((error) => {
  console.error('[openapi] 导出失败:', error.message);
  process.exit(1);
});
