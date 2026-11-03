import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { InternalServiceAuthGuard } from '../../common/auth/internal-service-auth.guard';
import { ANY_PRODUCT, AllowProducts } from '../../common/auth/allow-products.decorator';
import { ProductScopeGuard } from '../../common/auth/product-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { BizException, ErrorCode } from '../../common/error/error-code';
import { UserEntity } from '../user/entities/user.entity';
import { WalletStatus } from '../user/entities/user-status.enum';
import { WalletEntity } from '../wallet/entities/wallet.entity';
import { InternalBalanceQueryDto } from './dto/internal-wallet-query.dto';
import { InternalWalletBalanceView } from './dto/internal-wallet.vo';

/**
 * 内网 · 查用户余额（产品 → 门户）。
 *
 * ## 为什么单独做一个读接口
 *
 * 现在产品只能通过 `POST /api/wallet/deduct` 的返回值知道余额（`3001` 时带 `data.balance`）。
 * 那意味着"用户点了才发现余额不足"。有了这个接口，产品可以在计费前先展示余额、
 * 提前引导充值。
 *
 * ## 为什么不用 `GET /api/wallet/balance`
 *
 * 那个路径已经是**用户态**接口（用用户 JWT 查自己的余额）。同一个路径不能既接受
 * 用户 token 又接受服务凭据 —— 守卫会互相打架，而且"查自己的"和"查任何人的"
 * 混在一个 URL 上，出事时无法从日志区分。所以放在 `/api/internal/wallet/` 下。
 *
 * ## 只读，不建钱包
 *
 * `WalletService.balance()` 走的是 `ledger.ensureWallet()`（没有就创建）。这里是产品侧的
 * 批量轮询场景，不该因为一次查询就给用户造出钱包行，所以直接读、缺失则返回
 * `wallet_exists=false` + 余额 0。
 */
@ApiTags('内网计费 internal')
@ApiSecurity('service-bearer')
@Public()
@UseGuards(InternalServiceAuthGuard, ProductScopeGuard)
@AllowProducts(ANY_PRODUCT)
@Controller('internal/wallet')
export class InternalWalletQueryController {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(WalletEntity) private readonly wallets: Repository<WalletEntity>,
  ) {}

  @Get('balance')
  @ApiOperation({
    summary: '查用户余额（服务凭据）',
    description: [
      '产品在扣费前查询用户余额，用于提前提示充值。',
      '',
      '- **只读**：不会为用户创建钱包；从未有过资金往来的用户返回 `wallet_exists=false` + 余额 0',
      '- 金额单位是**分**，整数',
      '- `status=1` 表示钱包冻结，此时 `deduct` 会返回 `3002`',
      '- 余额为 0 不代表不能扣费成功——还需考虑并发扣款，最终以 `deduct` 的结果为准',
    ].join('\n'),
  })
  @ApiOkResponse({ type: InternalWalletBalanceView, description: '余额与钱包状态' })
  async balance(@Query() query: InternalBalanceQueryDto): Promise<InternalWalletBalanceView> {
    const portalUserId = query.portal_user_id;

    const exists = await this.users.exist({ where: { id: portalUserId } });
    if (!exists) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'portal_user_id 不存在');
    }

    const wallet = await this.wallets.findOne({ where: { userId: portalUserId } });
    if (!wallet) {
      return {
        portal_user_id: portalUserId,
        balance_cents: 0,
        status: 0,
        wallet_exists: false,
      };
    }

    return {
      portal_user_id: portalUserId,
      balance_cents: Number(wallet.balanceCents),
      status: wallet.status === WalletStatus.FROZEN ? 1 : 0,
      wallet_exists: true,
    };
  }
}
