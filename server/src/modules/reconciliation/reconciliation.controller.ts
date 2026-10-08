import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';

import { AdminGuard } from '../../common/admin.guard';
import { InternalKeyGuard } from '../../common/internal-key.guard';
import { Public } from '../../common/public.decorator';
import { ReportBillsDto } from '../order/dto/order.dto';
import { ProvisionWorker } from '../order/provision.worker';
import { ReconciliationService } from './reconciliation.service';

/**
 * 对账相关接口。
 * - `/api/admin/reconciliation/*`：管理端（X-Admin-Key）
 * - `/api/internal/reconciliation/report`：产品侧上报账单（X-Internal-Key）
 */
@ApiTags('管理端 admin')
@ApiSecurity('admin-key')
@Public()
@UseGuards(AdminGuard)
@Controller('admin/reconciliation')
export class AdminReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly worker: ProvisionWorker,
  ) {}

  @ApiOperation({
    summary: '日对账结果（契约 §6）',
    description:
      '不传 `date` 默认查前一日（UTC）。返回每产品的门户金额、产品金额、差异金额与三类差异笔数' +
      '（仅产品侧有 / 仅门户侧有 / 金额不一致），`detail` 里带差异 `bill_no` 列表。',
  })
  @ApiQuery({ name: 'date', required: false, example: '2026-10-08', description: '业务日 YYYY-MM-DD（UTC），缺省为前一日' })
  @Get('daily')
  async daily(@Query('date') date?: string): Promise<Record<string, unknown>> {
    return { ...(await this.reconciliation.queryDaily(date)) };
  }

  @ApiOperation({
    summary: '手动触发对账（补跑/排障）',
    description: '对指定日期与产品重新比对并覆盖结果。**差异不会自动修复**，只落库供人工处理。',
  })
  @Post('run')
  async run(@Body() body: { biz_date: string; product_code: string }): Promise<Record<string, unknown>> {
    return { ...(await this.reconciliation.reconcile(body.biz_date, body.product_code)) };
  }

  @ApiOperation({
    summary: '开通任务队列状态（排障）',
    description: '返回各状态任务数：`0` 待处理、`1` 处理中、`2` 成功、`3` 失败。堆积过多说明产品侧开通异常。',
  })
  @Get('provision-jobs')
  async provisionJobs(): Promise<Record<string, unknown>> {
    return { stats: await this.worker.stats() };
  }
}

@ApiTags('内网计费 internal')
@ApiSecurity('internal-key')
@Public()
@UseGuards(InternalKeyGuard)
@Controller('internal/reconciliation')
export class InternalReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @ApiOperation({
    summary: '产品账单上报（契约外补充，对账前置）',
    description:
      '产品侧把当日账单推给门户，门户据此与自己的流水逐笔比对。\n\n' +
      '幂等：以 `(biz_date, product_code, bill_no)` 唯一，重复上报覆盖金额。\n\n' +
      '需要 `X-Internal-Key`。产品侧不推也可以：把账单导出成 CSV 走人工对账，但自动对账会缺数据。',
  })
  @Post('report')
  async report(@Body() dto: ReportBillsDto): Promise<Record<string, unknown>> {
    return { ...(await this.reconciliation.reportBills(dto)) };
  }
}
