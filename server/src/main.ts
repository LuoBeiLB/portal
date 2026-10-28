import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { ResponseInterceptor } from './common/http/response.interceptor';
import { PortalConfigService } from './config/portal-config.service';
import { setupSwagger } from './config/swagger.setup';

// 在实例化任何 provider 之前读入 .env（Node 20+ 原生能力，无需 dotenv）
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

async function bootstrap(): Promise<void> {
  // rawBody 必须开启：内网服务凭据要对**原始字节**算 sha256（docs/27 §3.3）。
  // 用 express.json() 反序列化后再序列化算 hash 会因字段顺序/空格差异导致验签失败。
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(PortalConfigService);

  // 契约 §0.1：用户浏览器访问 https://<公网IP>/api/*
  // 例外：契约 §1.5 的 JWKS 挂在 /.well-known/jwks.json（产品侧内网直连取公钥）
  app.setGlobalPrefix('api', {
    /*
     * JWKS 有两个入口：
     *  - `/.well-known/jwks.json`        标准位置（不在 /api 下）
     *  - `/api/.well-known/jwks.json`    别名，产品方按 /api 直觉拼接时能命中
     * 两者都必须从全局前缀里排除，否则会被拼成 /api/.well-known 或 /api/api/...。
     */
    exclude: ['.well-known/jwks.json', 'api/.well-known/jwks.json'],
  });

  app.use(cookieParser());

  // 契约 §0.2：业务失败也返回 HTTP 200，业务码在 body（@RawResponse() 接口不套壳）
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      // 白名单：剔除未声明的属性，防止多余字段污染 DTO
      whitelist: true,
      // 不开启 forbidNonWhitelisted：查询串里带框架/前端附加参数（如 _t、status）不应 1001 报错
      forbidNonWhitelisted: false,
      stopAtFirstError: true,
    }),
  );

  app.enableShutdownHooks();

  // OpenAPI 文档：/api/docs（UI）+ /api/docs-json（导入 Apifox 用），生产默认关闭
  const swagger = setupSwagger(app, config);

  await app.listen(config.app.port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(
    `[cloud-portal] env=${config.app.env} listen=:${config.app.port} kid=${config.jwt.current.kid} products=${config.products
      .map((item) => item.code)
      .join(',')}${swagger ? ` docs=${swagger.path}` : ' docs=off'}`,
  );
}

void bootstrap();
