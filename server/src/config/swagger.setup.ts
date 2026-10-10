import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { PortalConfigService } from './portal-config.service';

/**
 * Swagger / OpenAPI 文档（给前端与产品侧联调用）。
 *
 * 产出：
 * - `/api/docs`      —— 可交互的 Swagger UI（按 SWAGGER_ENABLED 开关，生产默认关闭）
 * - `/api/docs-json` —— OpenAPI JSON，可直接导入 Apifox / Postman / Swagger Editor
 *
 * 为什么不直接暴露在 /api 下：`/api/docs*` 是运维/联调口，生产由 nginx 决定是否放行；
 * 契约里对外业务接口只有 `/api/*` 的业务路径。
 */
export function setupSwagger(
  app: INestApplication,
  config: PortalConfigService,
): { path: string; jsonPath: string } | null {
  if (!config.app.swaggerEnabled) return null;

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
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '门户签发的 access token（RS256，2h）' },
      'bearer',
    )
    .addApiKey({ type: 'apiKey', name: 'X-Internal-Key', in: 'header' }, 'internal-key')
    // 2026-10-10 起管理端改用管理员账号（role=admin 的 JWT），X-Admin-Key 方案已删除
    .addTag('认证 auth', '契约 §1：注册 / 登录 / 刷新 / 登出 / JWKS / 改密')
    .addTag('钱包 wallet', '契约 §3：余额 / 流水 / 充值申请')
    .addTag('内网计费 internal', '契约 §4：产品 → 门户（X-Internal-Key，仅内网）')
    .addTag('管理端 admin', '契约 §6：充值核销 / 用户管理 / 流水与日志 / 管理员账号（Bearer，需 role=admin）')
    .addTag('商城 shop', '契约 §2：商品与订单（round 3 实现）')
    .addTag('运维 ops', '探活与元信息')
    .build();

  const document = SwaggerModule.createDocument(app, builder, {
    // 让 DTO 的 @ApiProperty 描述生效；未加装饰器的字段仍会出现在 schema 中
    deepScanRoutes: true,
  });

  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: {
      // 便于前端逐条试接口：默认折叠，避免一次渲染上千行
      docExpansion: 'none',
      persistAuthorization: true,
      tagsSorter: 'alpha',
    },
  });

  return { path: '/api/docs', jsonPath: '/api/docs-json' };
}
