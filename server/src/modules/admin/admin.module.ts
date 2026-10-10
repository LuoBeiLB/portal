import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { UserEntity } from '../user/entities/user.entity';
import { TransactionEntity } from '../wallet/entities/transaction.entity';
import { WalletEntity } from '../wallet/entities/wallet.entity';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { AdminPortalController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * 管理端模块（2026-10-10 新增）。
 *
 * 承载前端《管理端-缺失接口需求清单》里的接口：用户查询、禁用/恢复、流水列表、
 * 操作日志、登录态校验、管理员账号管理。
 *
 * 审计能力在**全局** `AuditModule` 里提供 —— 原先挂在本地模块并 export，
 * 会形成 `AuthModule → AdminModule → AuthModule` 的循环依赖（Nest 启动报
 * "module at index [1] is undefined"）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, WalletEntity, TransactionEntity]), AuthModule, AuditModule],
  controllers: [AdminPortalController],
  providers: [AdminService, AdminBootstrapService],
  exports: [AdminService],
})
export class AdminModule {}
