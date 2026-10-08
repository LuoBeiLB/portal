import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AdminGuard } from './common/admin.guard';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { RedisModule } from './common/redis.module';
import { RedisStore } from './common/redis-store.service';
import { ConfigurationModule } from './config/configuration.module';
import { PortalConfigService } from './config/portal-config.service';
import { TokenModule } from './config/token.module';
import { PORTAL_ENTITIES } from './database/entities';
import { AuthModule } from './modules/auth/auth.module';
import { InternalModule } from './modules/internal/internal.module';
import { WalletModule } from './modules/wallet/wallet.module';

/**
 * 根模块。
 *
 * 已挂载：
 * - round 1：配置 + MySQL + 探活
 * - round 2：Redis + JWT 签发 + 认证（§1）+ 钱包（§3/§6）+ 内网计费（§4）
 * 待挂载：
 * - round 3：商品目录同步（§5.1）+ 订单与支付（§2）+ 开通与退款 + 日对账（§6）
 */
@Module({
  imports: [
    // .env 由 main.ts 在引导前读入 process.env（Node 20+ 原生 loadEnvFile）
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    ConfigurationModule,
    RedisModule,
    TokenModule,
    TypeOrmModule.forRootAsync({
      inject: [PortalConfigService],
      useFactory: (config: PortalConfigService) => ({
        type: 'mysql' as const,
        host: config.database.host,
        port: config.database.port,
        username: config.database.username,
        password: config.database.password,
        database: config.database.database,
        charset: config.database.charset,
        timezone: 'Z',
        supportBigNumbers: true,
        bigNumberStrings: true,
        // 严禁 synchronize：表结构一律走 migration:run（用户 2026-10-08 澄清的迁移纪律）
        synchronize: false,
        // 启动即验连接：失败快速退出并打印原因，避免运维在"起了但连不上库"的状态里排障
        retryAttempts: config.app.env === 'production' ? 10 : 2,
        retryDelay: 2000,
        logging: config.database.logging,
        entities: PORTAL_ENTITIES,
        extra: {
          connectionLimit: config.database.poolSize,
          charset: config.database.charset,
        },
      }),
    }),
    AuthModule,
    WalletModule,
    InternalModule,
  ],
  controllers: [AppController],
  providers: [
    AllExceptionsFilter,
    RedisStore,
    // 全局鉴权：未标 @Public() 的接口一律要求门户 JWT（契约 §0.3）
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // 管理端路由按需 @UseGuards(AdminGuard)
    AdminGuard,
  ],
  exports: [AdminGuard],
})
export class AppModule {}
