import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ConfigurationModule } from './config/configuration.module';
import { PortalConfigService } from './config/portal-config.service';
import { PORTAL_ENTITIES } from './database/entities';

/**
 * 根模块。
 *
 * 第 1 轮只挂：配置 + 数据库连接 + 探活。
 * 后续轮次按序挂入：AuthModule / WalletModule / ProductModule / OrderModule / InternalModule / AdminModule。
 */
@Module({
  imports: [
    // .env 由 main.ts 在引导前读入 process.env（Node 20+ 原生 loadEnvFile）
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    ConfigurationModule,
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
  ],
  controllers: [AppController],
  providers: [AllExceptionsFilter],
})
export class AppModule {}
