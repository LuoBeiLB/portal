import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AdminGuard } from './common/auth/admin.guard';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RateLimiterModule } from './common/redis/rate-limiter.service';
import { RedisModule } from './common/redis/redis.module';
import { RedisStore } from './common/redis/redis-store.service';
import { ConfigurationModule } from './config/configuration.module';
import { buildMysqlOptions } from './config/database.options';
import { PortalConfigService } from './config/portal-config.service';
import { TokenModule } from './config/token.module';
import { PORTAL_ENTITIES } from './database/entities';
import { AdminModule } from './modules/admin/admin.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { InternalModule } from './modules/internal/internal.module';
import { OrderModule } from './modules/order/order.module';
import { ProductModule } from './modules/product/product.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { WalletModule } from './modules/wallet/wallet.module';

/**
 * 根模块。
 *
 * 已挂载：
 * - round 1：配置 + MySQL + 探活
 * - round 2：Redis + JWT 签发 + 认证（§1）+ 钱包（§3/§6）+ 内网计费（§4）
 * - round 3：商品目录同步（§5.1）+ 商城与订单（§2）+ 开通 worker（§5.2）+ 对账（§6）
 * - round 4：管理员账号体系 + 操作审计 + 管理端运营接口
 */
@Module({
  imports: [
    // .env 由 main.ts 在引导前读入 process.env（Node 20+ 原生 loadEnvFile）
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    // 定时任务：商品同步（10 分钟）、开通 worker（3 秒轮询）、日对账（每日 04:10）
    ScheduleModule.forRoot(),
    ConfigurationModule,
    RedisModule,
    // 限流服务做成全局：登录/注册与**公开接口**（商品列表）都要用
    RateLimiterModule,
    TokenModule,
    TypeOrmModule.forRootAsync({
      inject: [PortalConfigService],
      useFactory: (config: PortalConfigService) => ({
        // 连接参数（含会话时区）与迁移 CLI 共用同一份构造，避免两边行为不一致
        ...buildMysqlOptions(config.database, config.database.poolSize),
        // 严禁 synchronize：表结构一律走 migration:run（用户 2026-10-08 澄清的迁移纪律）
        synchronize: false,
        // 启动即验连接：失败快速退出并打印原因，避免运维在"起了但连不上库"的状态里排障
        retryAttempts: config.app.env === 'production' ? 10 : 2,
        retryDelay: 2000,
        logging: config.database.logging,
        entities: PORTAL_ENTITIES,
      }),
    }),
    AuthModule,
    // 审计为全局模块：认证（改密码）、钱包（核销/导出）、对账、管理端都要写日志
    AuditModule,
    // 管理端：管理员账号体系（role=admin）+ 运营接口
    AdminModule,
    WalletModule,
    InternalModule,
    ProductModule,
    OrderModule,
    ReconciliationModule,
  ],
  controllers: [AppController],
  providers: [
    AllExceptionsFilter,
    RedisStore,
    // 全局鉴权：未标 @Public() 的接口一律要求门户 JWT（契约 §0.3）
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // 管理端路由用 @UseGuards(AdminGuard)，校验 JWT 里的 role=admin
    AdminGuard,
  ],
  exports: [AdminGuard],
})
export class AppModule {}
