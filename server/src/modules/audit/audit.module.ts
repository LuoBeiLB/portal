import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditService } from './audit.service';
import { AuditLogEntity } from './entities/audit-log.entity';

/**
 * 操作审计模块（**全局**）。
 *
 * 审计是横切关注点：认证（改密码）、钱包（核销/导出）、对账（手动触发）、
 * 管理端（用户/管理员管理）都要写日志。
 *
 * 早先把它挂在 AdminModule 下并 export，结果形成
 * `AuthModule → AdminModule → AuthModule` 的循环依赖（Nest 启动直接报
 * "module at index [1] is undefined"）。拆成独立全局模块后，谁都能注入，
 * 也不再需要 `forwardRef`。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLogEntity])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
