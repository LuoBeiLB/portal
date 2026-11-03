import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import type { UserEntity } from '../user/entities/user.entity';
import { UserRole, UserStatus } from '../user/entities/user-status.enum';
import { AdminService } from './admin.service';

/**
 * 管理端「重置普通用户密码」（2026-11-02 新增）。
 *
 * 补的是一个真实缺口：**个人用户（不属于任何企业）忘记密码后没有任何重置入口**
 * —— 企业员工能找企业管理员，个人用户找不到人。
 *
 * 三条行为约定在这里逐条钉死：
 * 1. 必须置 `must_change_password = 1`（管理员代设的密码要由用户自己改掉）
 * 2. 必须吊销全部会话（否则旧 refresh token 还能继续用）
 * 3. 不允许跨角色重置（管理员走另一个接口，审计时能区分对象类型）
 */
function make(options: { target?: Partial<UserEntity> | null } = {}) {
  const users = {
    findOne: jest.fn().mockResolvedValue(options.target === null ? null : { ...baseUser, ...(options.target ?? {}) }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const passwords = { hash: jest.fn().mockResolvedValue('$argon2id$hashed') };
  const tokens = { revokeAllSessions: jest.fn().mockResolvedValue(2) };
  const audit = { record: jest.fn(), ipOf: jest.fn() };

  const service = new AdminService(
    users as never,        // users
    {} as never,           // wallets
    {} as never,           // transactions
    passwords as unknown as PasswordService,
    tokens as unknown as TokenService,
    {} as never,           // dataSource
  );
  return { service, users, passwords, tokens };
}

const baseUser = {
  id: '019a-u1',
  username: 'zgl1',
  role: UserRole.USER,
  status: UserStatus.NORMAL,
  mustChangePassword: 0,
};

describe('AdminService.resetUserPassword（平台管理员重置普通用户密码）', () => {
  it('正常重置：写新密码 + 置强制改密 + 吊销全部会话', async () => {
    const { service, users, passwords, tokens } = make();
    const result = await service.resetUserPassword('019a-admin', '019a-u1', 'NewPass2026');

    expect(passwords.hash).toHaveBeenCalledWith('NewPass2026');
    expect(users.update).toHaveBeenCalledWith(
      { id: '019a-u1' },
      { passwordHash: '$argon2id$hashed', mustChangePassword: 1 },
    );
    expect(tokens.revokeAllSessions).toHaveBeenCalledWith('019a-u1');
    expect(result).toEqual({ ok: true, revoked_sessions: 2 });
  });

  it('用户不存在 → 4001', async () => {
    const { service } = make({ target: null });
    await expect(service.resetUserPassword('a', 'nope', 'NewPass2026')).rejects.toThrow(/用户不存在/);
  });

  it('目标是管理员 → 1004，并提示改用管理员接口', async () => {
    const { service, users } = make({ target: { role: UserRole.ADMIN } });
    await expect(service.resetUserPassword('a', '019a-u1', 'NewPass2026')).rejects.toThrow(
      /管理员管理接口/,
    );
    expect(users.update).not.toHaveBeenCalled();
  });

  it('目标是自己 → 1001，提示用改密接口', async () => {
    const { service } = make();
    await expect(service.resetUserPassword('019a-u1', '019a-u1', 'NewPass2026')).rejects.toThrow(
      /POST \/api\/auth\/password/,
    );
  });

  it('重置换密后必须强制改密（不能留成 0 让用户继续用管理员设的密码）', async () => {
    const { service, users } = make();
    await service.resetUserPassword('019a-admin', '019a-u1', 'NewPass2026');
    const patch = users.update.mock.calls[0][1];
    expect(patch.mustChangePassword).toBe(1);
  });
});
