import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { PortalConfigService } from './config/portal-config.service';

/**
 * 探活与元信息（挂在 `/api` 前缀下，与契约 §0.1 的对外路径一致）。
 * `/api/healthz` 供 nginx / 容器探活。
 */
@Controller('api')
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
