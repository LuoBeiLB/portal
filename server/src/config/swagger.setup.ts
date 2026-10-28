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
/**
 * 构造 OpenAPI 文档对象。
 *
 * **导出脚本（scripts/check/export-openapi.cjs）必须走这个函数**。
 * 早先它自己又 new 了一个 DocumentBuilder，导致这里改了安全方案、openapi.json 却不变
 * —— 两份定义长期漂移，前端拿到的是过期契约。
 */
export function buildSwaggerDocument(app: INestApplication): ReturnType<typeof SwaggerModule.createDocument> {

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
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description:
            '**用户** access token（门户签发，RS256，2h）。不用于 /api/internal/*、/api/wallet/* —— 那些走服务凭据', },
      'bearer',
    )
    /*
     * 内网接口认证方案（2026-10-27 起，docs/27）：不再是 X-Internal-Key 静态共享密钥，
     * 而是产品私钥签的 **60 秒 RS256 服务凭据**，门户用 p_service_key 里的产品公钥验签。
     * 与用户 token 同为 Bearer 头，但 iss/aud 不同，故单列一个 scheme 便于分别填写。
     */
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT (RS256 服务凭据)',
        description:
          '产品私钥签发的服务凭据（60 秒有效，aud=cloud-portal，含 htm/htu/qs/body_sha256/jti）。\n\n' +
          '由产品方在自己服务里签，**不是从门户获取**；门户用 p_service_key 中该产品的公钥验签。',
      },
      'service-bearer',
    )
    // 2026-10-10 起管理端改用管理员账号（role=admin 的 JWT），X-Admin-Key 方案已删除
    .addTag('认证 auth', '契约 §1：注册 / 登录 / 刷新 / 登出 / JWKS / 改密')
    .addTag('钱包 wallet', '契约 §3：余额 / 流水 / 充值申请')
    .addTag('内网计费 internal', '契约 §4：产品 → 门户（RS256 服务凭据，仅内网）')
    .addTag('内网 · 企业成员 internal', '产品 → 门户：拉某企业成员（RS256 服务凭据）')
    .addTag('管理端 admin', '契约 §6：充值核销 / 用户管理 / 流水与日志 / 管理员账号（Bearer，需 role=admin）')
    .addTag('商城 shop', '契约 §2：商品与订单（round 3 实现）')
    .addTag('运维 ops', '探活与元信息')
    .build();

  const document = SwaggerModule.createDocument(app, builder, {
    // 让 DTO 的 @ApiProperty 描述生效；未加装饰器的字段仍会出现在 schema 中
    deepScanRoutes: true,
  });
  return document;
}

export function setupSwagger(
  app: INestApplication,
  config: PortalConfigService,
): { path: string; jsonPath: string } | null {
  if (!config.app.swaggerEnabled) return null;

  const document = buildSwaggerDocument(app);

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
