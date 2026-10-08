import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ResponseInterceptor } from './common/response.interceptor';
import { PortalConfigService } from './config/portal-config.service';

// 在实例化任何 provider 之前读入 .env（Node 20+ 原生能力，无需 dotenv）
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(PortalConfigService);

  // 契约 §0.1：用户浏览器访问 https://<公网IP>/api/*
  // （JWKS 例外：契约 §1.5 要求挂在 /.well-known/jwks.json，后续轮次单独注册）
  app.setGlobalPrefix('api');

  app.use(cookieParser());

  // 契约 §0.2：业务失败也返回 HTTP 200，业务码在 body
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      stopAtFirstError: true,
    }),
  );

  app.enableShutdownHooks();

  await app.listen(config.app.port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(
    `[cloud-portal] env=${config.app.env} listen=:${config.app.port} kid=${config.jwt.current.kid} products=${config.products
      .map((item) => item.code)
      .join(',')}`,
  );
}

void bootstrap();
