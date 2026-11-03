import { BizException, ErrorCode } from '../error/error-code';
import { PortalConfigService } from '../../config/portal-config.service';
import { LegacyWalletApiGuard } from './legacy-wallet-api.guard';

/**
 * 旧内网计费接口的总闸（`/api/wallet/deduct`、`/api/wallet/refund`）。
 *
 * 2026-11-03 起开通统一走 `POST /api/internal/orders`（下单即扣款），
 * 两个能扣钱的入口同时开着会造成双轨记账，所以旧的默认关闭。
 *
 * 代码保留（不删）：出问题时可用 `INTERNAL_LEGACY_WALLET_API=true` 临时打开过渡。
 */
function make(enabled: boolean) {
  const config = { internal: { legacyWalletApiEnabled: enabled } } as unknown as PortalConfigService;
  return { guard: new LegacyWalletApiGuard(config) };
}

describe('LegacyWalletApiGuard（旧计费接口总闸）', () => {
  it('默认关闭：拒绝，并说明改用 /api/internal/orders', () => {
    const { guard } = make(false);

    let thrown: unknown = null;
    try {
      guard.canActivate();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BizException);
    expect((thrown as BizException).code).toBe(ErrorCode.FORBIDDEN);
    const message = (thrown as BizException).message;
    expect(message).toMatch(/已停用/);
    /* 必须告诉运维怎么临时打开 —— 否则只能翻代码 */
    expect(message).toMatch(/INTERNAL_LEGACY_WALLET_API=true/);
    expect(message).toMatch(/internal\/orders/);
  });

  it('显式打开（过渡/回滚）→ 放行，后续仍由验签与白名单把关', () => {
    const { guard } = make(true);
    expect(guard.canActivate()).toBe(true);
  });
});
