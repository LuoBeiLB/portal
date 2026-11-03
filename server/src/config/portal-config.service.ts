import { Injectable } from '@nestjs/common';

import { loadConfig, PortalConfig } from './configuration';

/**
 * 类型化配置访问入口。
 * 内部直接用 loadConfig() 读取（进程内只执行一次），不依赖 @nestjs/config 的字符串路径，
 * 避免 `configService.get('xxx')` 满天飞导致拼写错误。
 */
@Injectable()
export class PortalConfigService {
  private readonly config: PortalConfig = loadConfig();

  get all(): PortalConfig {
    return this.config;
  }

  get app() {
    return this.config.app;
  }

  get database() {
    return this.config.database;
  }

  get redis() {
    return this.config.redis;
  }

  get jwt() {
    return this.config.jwt;
  }

  get security() {
    return this.config.security;
  }

  get shop() {
    return this.config.shop;
  }

  get wallet() {
    return this.config.wallet;
  }

  get products() {
    return this.config.products;
  }

  isProduction(): boolean {
    return this.config.app.env === 'production';
  }
}
