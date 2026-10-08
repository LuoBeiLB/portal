import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Public } from './common/public.decorator';
import { PortalConfigService } from './config/portal-config.service';

/**
 * 探活与元信息。挂在全局 `/api` 前缀下，实际路径为 `/api/healthz`、`/api/meta`。
 * ⚠️ 不要在这里再写 @Controller('api')，否则路径会叠加成 /api/api/*。
 *
 * 两个接口都标 @Public()：探活是给 nginx / 容器用的，不带用户 token。
 * 其中 meta 只暴露服务名、契约版本、kid 与产品代码，不含密钥，供排障比对。
 */
@Public()
@Controller()
export class AppController {
  constructor(
    private readonly config: PortalConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Get('healthz')
  async health(): Promise<Record<string, unknown>> {
    let database = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      database = 'up';
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      env: this.config.app.env,
      database,
      time: new Date().toISOString(),
    };
  }

  @Get('meta')
  meta(): Record<string, unknown> {
    return {
      service: 'cloud-portal',
      contract: '云平台统一门户 API 契约 v1.0 (2026-09-30)',
      issuer: this.config.jwt.issuer,
      jwtKid: this.config.jwt.current.kid,
      accessTtlSeconds: this.config.jwt.accessTtlSeconds,
      refreshTtlSeconds: this.config.jwt.refreshTtlSeconds,
      products: this.config.products.map((item) => item.code),
      time: new Date().toISOString(),
    };
  }
}
