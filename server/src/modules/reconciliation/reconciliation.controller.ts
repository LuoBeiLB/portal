import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { AdminGuard } from '../../common/admin.guard';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { InternalKeyGuard } from '../../common/internal-key.guard';
import { CurrentInternalProduct } from '../../common/internal-product.decorator';
import { InternalProduct } from '../../common/internal-product.types';
import { ProductScopeGuard } from '../../common/product-scope.guard';
import { Public } from '../../common/public.decorator';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { ReportBillsDto, RunReconciliationDto } from '../order/dto/order.dto';
import { ProvisionWorker } from '../order/provision.worker';
import { ReconciliationService } from './reconciliation.service';
import { ProvisionJobsView, ReconciliationView, ReportBillsView } from '../../common/dto/common.vo';

/**
 * 对账相关接口。
 * - `/api/admin/reconciliation/*`：管理端（**管理员账号**，`role=admin` 的 JWT）
 * - `/api/internal/reconciliation/report`：产品侧上报账单（X-Internal-Key）
 *
 * ⚠️ 管理端**刻意不标 `@Public()`**：必须经过全局 JwtAuthGuard 填充 `request.user`，
 * `AdminGuard` 才能读到角色（2026-10-10 起废弃静态 X-Admin-Key）。
 */
@ApiTags('管理端 admin')
@ApiBearerAuth('bearer')
@UseGuards(AdminGuard)
@Controller('admin/reconciliation')
export class AdminReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly worker: ProvisionWorker,
    private readonly audit: AuditService,
  ) {}

  @ApiOperation({
    summary: '日对账结果（契约 §6）',
    description:
      '不传 `date` 默认查前一日（UTC）。返回每产品的门户金额、产品金额、差异金额与三类差异笔数' +
      '（仅产品侧有 / 仅门户侧有 / 金额不一致），`detail` 里带差异 `bill_no` 列表。',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    example: '2026-10-08',
    description: '业务日 YYYY-MM-DD（UTC），缺省为前一日',
  })
  @ApiOkResponse({ description: '统一响应壳，data 为对账结果', type: ReconciliationView })
  @Get('daily')
  async daily(@Query('date') date?: string): Promise<Record<string, unknown>> {
    return { ...(await this.reconciliation.queryDaily(date)) };
  }

  @ApiOperation({
    summary: '手动触发对账（补跑/排障）',
    description:
      '对指定日期与产品重新比对并覆盖结果。**差异不会自动修复**，只落库供人工处理。\n\n' +
      '正常情况每天 04:10（UTC）自动对前一日；这个接口用于漏跑补数或排查差异。',
  })
  @HttpCode(200)
  @ApiOkResponse({ description: '统一响应壳，data 为对账结果', type: ReconciliationView })
  @Post('run')
  async run(
    @CurrentUser() user: AuthUser,
    @Body() body: RunReconciliationDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    const result = await this.reconciliation.reconcile(body.biz_date, body.product_code);

    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: AuditAction.RECONCILIATION_RUN,
      target: `recon:${body.biz_date}:${body.product_code}`,
      detail: { ...(result as unknown as Record<string, unknown>) },
      ip: this.audit.ipOf(request),
    });

    return { ...result };
  }

  @ApiOperation({
    summary: '开通任务队列状态（排障）',
    description: '返回各状态任务数：`0` 待处理、`1` 处理中、`2` 成功、`3` 失败。堆积过多说明产品侧开通异常。',
  })
  @ApiOkResponse({ description: '统一响应壳，data 为开通任务统计', type: ProvisionJobsView })
  @Get('provision-jobs')
  async provisionJobs(): Promise<Record<string, unknown>> {
    return { stats: await this.worker.stats() };
  }
}

@ApiTags('内网计费 internal')
@ApiSecurity('internal-key')
@Public()
@UseGuards(InternalKeyGuard, ProductScopeGuard)
@Controller('internal/reconciliation')
export class InternalReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @ApiOperation({
    summary: '产品账单上报（契约外补充，对账前置）',
    description:
      '产品侧把当日账单推给门户，门户据此与自己的流水逐笔比对。\n\n' +
      '幂等：以 `(biz_date, product_code, bill_no)` 唯一，重复上报覆盖金额。\n\n' +
      '**`product_code` 以 `X-Internal-Key` 的归属为准**：传了必须一致（否则 1004），不传则按密钥推定。\n\n' +
      '需要 `X-Internal-Key`。产品侧不推也可以：把账单导出成 CSV 走人工对账，但自动对账会缺数据。',
  })
  @HttpCode(200)
  @ApiOkResponse({ description: '统一响应壳，data 为接收与落库条数', type: ReportBillsView })
  @Post('report')
  async report(
    @Body() dto: ReportBillsDto,
    @CurrentInternalProduct() product: InternalProduct,
  ): Promise<Record<string, unknown>> {
    // 强制用认证结果：防止产品把自己的账报到别人的 product_code 下（会污染对账口径）
    return { ...(await this.reconciliation.reportBills({ ...dto, product_code: product.code })) };
  }
}
