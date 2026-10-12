import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { clientIpOf } from '../../common/request.util';
import { PortalConfigService } from '../../config/portal-config.service';
import { AuditAction, AuditLogEntity, AuditLogView } from './entities/audit-log.entity';

export interface AuditRecordInput {
  /** 操作人 `u_user.id`；系统动作为 `'system'` */
  operatorId: string;
  operator: string;
  action: AuditAction;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

/**
 * 操作审计（2026-10-10 新增）。
 *
 * 设计要点：
 * 1. **写日志不能拖垮业务**：核销充值、禁用用户这些是主流程，审计失败只记 WARN，
 *    绝不因为日志写不进去就让资金操作失败（可用性优先）。
 * 2. **只记写操作与导出**：读接口不记，否则列表查询会把日志刷满，真正要追责的操作被埋掉。
 * 3. `operatorId` 一律由调用方从**已验证的 JWT** 传入，绝不接受前端自报。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  /** 系统动作的操作人标识（如环境变量 bootstrap 建首个管理员） */
  static readonly SYSTEM_OPERATOR_ID = 'system';
  static readonly SYSTEM_OPERATOR_NAME = 'system';

  constructor(
    @InjectRepository(AuditLogEntity) private readonly logs: Repository<AuditLogEntity>,
    private readonly config: PortalConfigService,
  ) {}

  /** 记录一条审计；失败不抛错（只 WARN），避免影响主流程 */
  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.logs.insert({
        operatorId: input.operatorId,
        operator: input.operator,
        action: input.action,
        target: input.target ?? null,
        // json 列在 TypeORM 的 _QueryDeepPartialEntity 上类型较窄，这里显式断言
        detail: (input.detail ?? null) as never,
        ip: input.ip ?? null,
        // `created_at` 不显式写：由库侧 DEFAULT CURRENT_TIMESTAMP(3) 生成（2026-10-12 统一口径）
      });
    } catch (error) {
      this.logger.warn(
        `审计日志写入失败 action=${input.action} operator=${input.operator}：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 从请求里取客户端 IP（写审计时统一用，避免各处重复实现） */
  ipOf(request: unknown): string | null {
    try {
      return clientIpOf(request as never) ?? null;
    } catch {
      return null;
    }
  }

  /** 管理端分页查询（§ 前端需求清单：GET /api/admin/audit-logs） */
  async list(filter: {
    page: number;
    size: number;
    operator?: string;
    action?: string;
    target?: string;
    start_date?: string;
    end_date?: string;
  }): Promise<{ list: AuditLogView[]; total: number; page: number; size: number }> {
    const qb = this.logs.createQueryBuilder('a').orderBy('a.id', 'DESC');

    if (filter.operator) {
      // 用户名或操作人 ID 都支持（运营通常按用户名找）
      qb.andWhere('(a.operator LIKE :op OR a.operator_id = :opId)', {
        op: `%${filter.operator}%`,
        opId: filter.operator,
      });
    }
    if (filter.action) qb.andWhere('a.action = :action', { action: filter.action });
    if (filter.target) qb.andWhere('a.target LIKE :target', { target: `%${filter.target}%` });

    // 日期区间按 UTC 自然日，**含当日**（前端要求：查某天的操作记录）
    if (filter.start_date) {
      qb.andWhere('a.created_at >= :start', { start: `${filter.start_date} 00:00:00.000` });
    }
    if (filter.end_date) {
      qb.andWhere('a.created_at <= :end', { end: `${filter.end_date} 23:59:59.999` });
    }

    const [rows, total] = await qb
      .skip((filter.page - 1) * filter.size)
      .take(filter.size)
      .getManyAndCount();

    return {
      list: rows.map((row) => ({
        id: row.id,
        operator_id: row.operatorId,
        operator: row.operator,
        action: row.action,
        target: row.target,
        detail: row.detail,
        ip: row.ip,
        created_at: toIsoUtc(row.createdAt) ?? '',
      })),
      total,
      page: filter.page,
      size: filter.size,
    };
  }
}

/** UTC ISO 8601，不带毫秒（契约 §0.4） */
export function toIsoUtc(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
