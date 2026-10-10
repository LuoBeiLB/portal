import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { PortalConfigService } from '../../config/portal-config.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { AdminService } from './admin.service';

/**
 * 首个管理员的引导（环境变量，幂等）。
 *
 * ## 为什么首个管理员用环境变量而不是接口
 *
 * 如果"首个管理员"也靠接口创建，就会出现一个**时间窗**：
 * 从服务可访问到管理员建好之间，任何能调到该接口的人都能把自己变成管理员。
 * 用环境变量则部署完就是安全的——配置文件本身就等同于服务器访问权限。
 *
 * ## 为什么每次启动都校准密码
 *
 * 幂等 + 每次覆盖密码 ⇒ 它同时是**忘记密码的找回入口**：
 * 改 `.env` 里的 `ADMIN_PASSWORD` 重启即可，不需要连数据库改哈希。
 *
 * 只在首次创建时打日志；已存在时只打 debug，避免每次启动都刷屏。
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private readonly config: PortalConfigService,
    private readonly admin: AdminService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { username, password, phone } = this.config.security.adminBootstrap;

    if (!username || !password) {
      // 未配置不算错误：可能管理员已经建好了，或用的是别的创建方式
      this.logger.log('未配置 ADMIN_USERNAME / ADMIN_PASSWORD，跳过首个管理员引导');
      return;
    }

    try {
      const result = await this.admin.bootstrapAdmin(username, password, phone);

      if (result === 'created') {
        this.logger.log(`已创建首个管理员：${username}`);
        await this.audit.record({
          operatorId: AuditService.SYSTEM_OPERATOR_ID,
          operator: AuditService.SYSTEM_OPERATOR_NAME,
          action: AuditAction.SYSTEM_BOOTSTRAP,
          target: `admin:${username}`,
          detail: { via: 'env', result: 'created' },
        });
      } else {
        this.logger.debug(`管理员 ${username} 已存在，已按环境变量校准密码与角色`);
        await this.audit.record({
          operatorId: AuditService.SYSTEM_OPERATOR_ID,
          operator: AuditService.SYSTEM_OPERATOR_NAME,
          action: AuditAction.SYSTEM_BOOTSTRAP,
          target: `admin:${username}`,
          detail: { via: 'env', result: 'updated' },
        });
      }
    } catch (error) {
      // 引导失败不能阻塞启动（否则配置写错就起不来），但要显式告警
      this.logger.error(
        `首个管理员引导失败（服务仍会启动，请检查 ADMIN_* 配置）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
