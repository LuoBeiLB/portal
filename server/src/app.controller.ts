import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { HealthView, MetaView } from './common/dto/common.vo';
import { Public } from './common/public.decorator';
import { PortalConfigService } from './config/portal-config.service';

/**
 * 探活与元信息。挂在全局 `/api` 前缀下，实际路径为 `/api/healthz`、`/api/meta`。
 * ⚠️ 不要在这里再写 @Controller('api')，否则路径会叠加成 /api/api/*。
 *
 * 两个接口都标 @Public()：探活是给 nginx / 容器用的，不带用户 token。
 * 其中 meta 只暴露服务名、契约版本、kid 与产品代码，不含密钥，供排障比对。
 */
@ApiTags('运维 ops')
@Public()
@Controller()
export class AppController {
  constructor(
    private readonly config: PortalConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @ApiOperation({
    summary: '探活（运维）',
    description: '供 nginx / 容器探活。`data.status`：ok=数据库可达；degraded=数据库不可达。无需鉴权。',
  })
  @ApiOkResponse({ description: '统一响应壳，data 为探活结果', type: HealthView })
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

  @ApiOperation({
    summary: '服务元信息（运维）',
    description: '返回服务名、契约版本、JWT issuer 与 kid、各产品接入代码。**不含任何密钥**，供排障比对。',
  })
  @ApiOkResponse({ description: '统一响应壳，data 为服务元信息', type: MetaView })
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
