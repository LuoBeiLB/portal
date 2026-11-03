import { CanActivate, Injectable } from '@nestjs/common';

import { BizException, ErrorCode } from '../error/error-code';
import { PortalConfigService } from '../../config/portal-config.service';

/**
 * 旧内网计费接口（`/api/wallet/deduct`、`/api/wallet/refund`）的**总闸**。
 *
 * ## 为什么关掉
 *
 * 2026-11-03 起，产品的开通链路统一走 `POST /api/internal/orders`
 * （服务端下单：下单 + 扣款 + 入队开通一步完成，见 `docs/30`）。
 * 旧的「先 deduct 扣费、再单独触发开通」已经被这条链路取代，
 * 留着两个入口同时能扣钱，等于允许**双轨记账** —— 对账会分不清哪笔是订单、哪笔是裸扣费。
 *
 * ## 为什么是"关"不是"删"
 *
 * 代码保留，用开关 `INTERNAL_LEGACY_WALLET_API` 控制（默认 `false`）：
 * - 出问题时可临时打开做过渡（无需重新发版）
 * - 参考实现留着，未来若有"纯按量计费"场景（不涉及开通）可复用
 *
 * ## ⚠️ 关掉之后按量计费怎么办
 *
 * `deduct` 目前也是**后付费/按量计费**的出账通道（契约 §4.1，`billing_mode=2` 的产品
 * 靠它扣钱）。关掉后：
 * - 预付购买（`billing_mode=1`）→ 走 `/internal/orders`，不受影响
 * - **按量出账（`billing_mode=2`）→ 暂无替代通道**，需要先确认没有产品在用
 *
 * 所以本开关关闭前，必须确认所有产品的 SKU 都是预付（`billing_mode=1`）。
 */
@Injectable()
export class LegacyWalletApiGuard implements CanActivate {
  constructor(private readonly config: PortalConfigService) {}

  canActivate(): boolean {
    if (this.config.internal.legacyWalletApiEnabled) return true;

    throw new BizException(
      ErrorCode.FORBIDDEN,
      '该接口已停用：产品的扣费/退款改由 POST /api/internal/orders（下单即扣款）一步完成，' +
        '详见 docs/30。如确需临时开启，请设置 INTERNAL_LEGACY_WALLET_API=true 并重启门户。',
    );
  }
}
