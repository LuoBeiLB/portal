import { Repository } from 'typeorm';

import { WalletStatus } from '../user/entities/user-status.enum';
import { UserEntity } from '../user/entities/user.entity';
import { WalletEntity } from '../wallet/entities/wallet.entity';
import { InternalWalletQueryController } from './internal-wallet-query.controller';

/**
 * 产品查用户余额（只读）。
 *
 * 关键行为：
 * - 用户不存在 → 1001，不能返回 0（否则产品会以为"有人、没钱"）
 * - 没有钱包 → `wallet_exists=false` + 0，**不能顺手创建钱包**（读接口不该有副作用）
 * - 冻结钱包 → `status=1`，产品据此提示"账户被冻结"而不是"余额不足"
 */
function make(options: { userExists?: boolean; wallet?: Partial<WalletEntity> | null } = {}) {
  const users = { exist: jest.fn().mockResolvedValue(options.userExists ?? true) };
  const wallets = {
    findOne: jest.fn().mockResolvedValue(options.wallet === undefined ? null : options.wallet),
  };
  const controller = new InternalWalletQueryController(
    users as unknown as Repository<UserEntity>,
    wallets as unknown as Repository<WalletEntity>,
  );
  return { controller, users, wallets };
}

const query = { portal_user_id: '01a1b2c3-d4e5-6f70-8192-a3b4c5d6e7f8' };

describe('InternalWalletQueryController（产品查余额）', () => {
  it('正常钱包 → 返回余额（分）与状态 0', async () => {
    const { controller } = make({ wallet: { userId: query.portal_user_id, balanceCents: '12345', status: WalletStatus.NORMAL } });
    const result = await controller.balance(query);

    expect(result).toEqual({
      portal_user_id: query.portal_user_id,
      balance_cents: 12345,
      status: 0,
      wallet_exists: true,
    });
  });

  it('冻结钱包 → status=1（产品据此提示冻结而不是余额不足）', async () => {
    const { controller } = make({ wallet: { balanceCents: '500', status: WalletStatus.FROZEN } });
    const result = await controller.balance(query);
    expect(result.status).toBe(1);
    expect(result.balance_cents).toBe(500);
  });

  it('没有钱包 → wallet_exists=false + 余额 0，且不做任何写操作', async () => {
    const { controller, wallets } = make({ wallet: null });
    const result = await controller.balance(query);

    expect(result).toEqual({
      portal_user_id: query.portal_user_id,
      balance_cents: 0,
      status: 0,
      wallet_exists: false,
    });
    /* 读接口不能有副作用：只允许 findOne，不应出现 save/insert */
    expect(Object.keys(wallets)).toEqual(['findOne']);
  });

  it('用户不存在 → 1001，不返回 0', async () => {
    const { controller, wallets } = make({ userExists: false });
    await expect(controller.balance(query)).rejects.toThrow(/portal_user_id 不存在/);
    expect(wallets.findOne).not.toHaveBeenCalled();
  });

  it('大额余额不丢精度（bigint 以字符串存储）', async () => {
    const { controller } = make({ wallet: { balanceCents: '9007199254740991', status: WalletStatus.NORMAL } });
    const result = await controller.balance(query);
    expect(result.balance_cents).toBe(9007199254740991);
  });
});
