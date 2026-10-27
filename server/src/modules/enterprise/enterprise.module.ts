import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EnterpriseAdminGuard } from '../../common/auth/enterprise-admin.guard';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { UserEntity } from '../user/entities/user.entity';
import { WalletEntity } from '../wallet/entities/wallet.entity';
import { EnterpriseAdminController, EnterpriseUserAdminController } from './enterprise-admin.controller';
import { ConsoleController } from './console.controller';
import { EnterpriseRegisterController } from './enterprise-register.controller';
import { EnterpriseOwnerController } from './enterprise.controller';
import { EnterpriseService } from './enterprise.service';
import { EnterpriseEntity } from './entities/enterprise.entity';

/**
 * 企业模块（2026-10-19 新增，对应 `docs/24` 的 M1）。
 *
 * 只承载**门户侧**的企业能力：
 *
 * - 建企业 / 指定所有者 / 给已有账号分配企业（管理端，跨企业）
 * - 企业所有者管本企业员工（企业端，`enterprise_id` 从登录态取）
 *
 * **不承载**：部门、角色、数据权限、资源分配 —— 那些在云存储侧（`docs/21`）。
 * 角色模板也不在这里建：由云存储在该企业首次被访问时惰性创建（`docs/18` §4.2.1）。
 *
 * `PasswordService` / `TokenService` 直接从 `AuthModule` 取（它是全局导出这些的），
 * 不要在这里再 provide 一遍 —— 会造出第二份实例，与登录路径的配置不一致。
 */
@Module({
  imports: [TypeOrmModule.forFeature([EnterpriseEntity, UserEntity, WalletEntity]), AuthModule, AuditModule],
  controllers: [
    EnterpriseAdminController,
    EnterpriseUserAdminController,
    EnterpriseOwnerController,
    EnterpriseRegisterController,
    ConsoleController,
  ],
  providers: [EnterpriseService, EnterpriseAdminGuard],
  exports: [EnterpriseService],
})
export class EnterpriseModule {}
