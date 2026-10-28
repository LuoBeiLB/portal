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

const { AppModule } = require('../../dist/app.module');
const { PortalConfigService } = require('../../dist/config/portal-config.service');
const { buildSwaggerDocument } = require('../../dist/config/swagger.setup');

(async () => {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  /* 与 main.ts 保持一致：JWKS 有标准路径和 /api 别名两条，都要排除全局前缀 */
  app.setGlobalPrefix('api', { exclude: ['.well-known/jwks.json', 'api/.well-known/jwks.json'] });

  const config = app.get(PortalConfigService);
  /* 只为校验配置可解析；文档统一由 buildSwaggerDocument 生成 */
  void config;

  /*
   * 复用 swagger.setup.ts 的 buildSwaggerDocument —— 这是**唯一**的文档定义来源。
   *
   * 早先这里自己又 new 了一个 DocumentBuilder（连安全方案都重复声明一遍），
   * 结果是：swagger.setup.ts 改了 internal-key → service-bearer，导出的 openapi.json 却不变，
   * 前端/产品侧拿到的是过期契约。这种"两份定义"的坑不值得再踩第二次。
   */
  const document = buildSwaggerDocument(app);

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
