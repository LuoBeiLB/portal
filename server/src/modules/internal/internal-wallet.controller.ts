import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BizException, ErrorCode } from '../../common/error-code';
import { InternalKeyGuard } from '../../common/internal-key.guard';
import { Public } from '../../common/public.decorator';
import { withBizCode } from '../../common/response.interceptor';
import { UserEntity } from '../user/entities/user.entity';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { DeductDto, RefundDto } from './dto/internal.dto';

/**
 * 契约 §4 内网计费接口（产品 → 门户）。
 *
 * ⚠️ 安全前提：这些接口**只校验 X-Internal-Key**，必须由防火墙/nginx 保证不对公网暴露
 * （契约附录自检项）。响应遵循 §0.2；幂等重复按 §4.1 返回 code=3003 且 data 为首次结果。
 */
@ApiTags('内网计费 internal')
@ApiSecurity('internal-key')
@Public()
@UseGuards(InternalKeyGuard)
@Controller('wallet')
export class InternalWalletController {
  constructor(
    private readonly ledger: WalletLedgerService,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
  ) {}

  /** §4.1 扣费。产品侧纪律：账单先落库（status=0）→ 调本接口 → code=0 改 status=1 */
  @ApiOperation({
    summary: '扣费（契约 §4.1）',
    description:
      '产品 → 门户。幂等键 bill_no：重复提交返回 code=3003，data 为首次结果（**视为成功**）。\n\n' +
      '错误：3001 余额不足（`data.balance` 带当前余额，**不重试**）、3002 钱包冻结（不重试）、1001 参数错误。\n\n' +
      '产品实现要点：账单先落库 → 调本接口 → code=0 改 status=1；网络超时/5xx 用**同一 bill_no** 退避重试（1s/5s/30s）。',
  })
  @HttpCode(200)
  @ApiOkResponse({ description: '契约 §0.2：业务响应统一 HTTP 200，结果看 body 的 code' })
  @Post('deduct')
  async deduct(@Body() dto: DeductDto): Promise<unknown> {
    await this.assertUserExists(dto.portal_user_id);

    const result = await this.ledger.deduct({
      userId: dto.portal_user_id,
      billNo: dto.bill_no,
      amountCents: dto.amount_cents,
      productCode: dto.product_code,
      detail: dto.detail ?? null,
    });

    const data = {
      balance_after: Number(result.balanceAfter),
      transaction_id: result.transactionId,
      ...(result.idempotentRepeated ? { idempotent_repeated: true } : {}),
    };

    // 幂等重复：契约明确「code=3003 且 data 为首次结果」，产品侧应视为成功
    return result.idempotentRepeated ? withBizCode(ErrorCode.IDEMPOTENT_REPEATED, data, 'duplicate bill_no') : data;
  }

  /** §4.2 退款。refund_bill_no 是幂等键；累计退款不得超过原单金额（3004） */
  @ApiOperation({
    summary: '退款（契约 §4.2）',
    description:
      '产品 → 门户。幂等键 refund_bill_no。退款退回**原扣费账单所属的钱包**，调用方无需传 userId。\n\n' +
      '错误：3005 原 bill_no 未入账、3004 累计退款超出原单可退余额（`data.refundable_cents` 给出剩余可退）。',
  })
  @HttpCode(200)
  @ApiOkResponse({ description: '契约 §0.2：业务响应统一 HTTP 200，结果看 body 的 code' })
  @Post('refund')
  async refund(@Body() dto: RefundDto): Promise<unknown> {
    const result = await this.ledger.refund({
      billNo: dto.bill_no,
      refundBillNo: dto.refund_bill_no,
      amountCents: dto.amount_cents,
      reason: dto.reason ?? null,
    });

    const data = {
      balance_after: Number(result.balanceAfter),
      transaction_id: result.transactionId,
      ...(result.idempotentRepeated ? { idempotent_repeated: true } : {}),
    };

    return result.idempotentRepeated
      ? withBizCode(ErrorCode.IDEMPOTENT_REPEATED, data, 'duplicate refund_bill_no')
      : data;
  }

  private async assertUserExists(userId: string): Promise<void> {
    // 门户用户不存在时不能凭空建钱包（影子用户由产品侧建档，门户是权威源）
    const exists = await this.users.exist({ where: { id: userId } });
    if (!exists) throw new BizException(ErrorCode.PARAM_INVALID, 'portal_user_id 不存在');
  }
}
