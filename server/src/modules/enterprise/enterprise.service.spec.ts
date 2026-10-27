import { BizException, ErrorCode } from '../../common/error/error-code';
import { UserRole, UserStatus, UserType } from '../user/entities/user-status.enum';
import { UserEntity } from '../user/entities/user.entity';
import { EnterpriseEntity, EnterpriseStatus } from './entities/enterprise.entity';
import { EnterpriseService, generateInitialPassword } from './enterprise.service';

/* ────────────────── 测试替身 ────────────────── */

function userOf(overrides: Partial<UserEntity> = {}): UserEntity {
  return {
    id: 'u-1',
    username: 'liming',
    phone: null,
    passwordHash: 'hash',
    role: UserRole.USER,
    userType: UserType.PERSONAL,
    enterpriseId: null,
    status: UserStatus.NORMAL,
    mustChangePassword: 0,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    updatedAt: new Date('2026-10-19T00:00:00Z'),
    ...overrides,
  } as UserEntity;
}

function enterpriseOf(overrides: Partial<EnterpriseEntity> = {}): EnterpriseEntity {
  return {
    id: '1',
    code: 'acme',
    name: '云存储公司',
    status: EnterpriseStatus.PENDING,
    quotaBytes: '0',
    ownerUserId: null,
    expireAt: null,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    updatedAt: new Date('2026-10-19T00:00:00Z'),
    ...overrides,
  } as EnterpriseEntity;
}

interface Harness {
  service: EnterpriseService;
  enterprises: { findOne: jest.Mock; findOneOrFail: jest.Mock; save: jest.Mock; create: jest.Mock; find: jest.Mock };
  users: { findOne: jest.Mock; findOneOrFail: jest.Mock; update: jest.Mock; createQueryBuilder: jest.Mock };
  manager: { update: jest.Mock; create: jest.Mock; save: jest.Mock };
  tokens: { revokeAllSessions: jest.Mock };
  password: { hash: jest.Mock; verify: jest.Mock };
}

function harness(): Harness {
  const manager = {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn().mockResolvedValue({ id: 'new-user' }),
  };
  const enterprises = {
    findOne: jest.fn(),
    // save 后 service 会回读一次拿库侧默认值（created_at），这里用带时间的实体顶替
    findOneOrFail: jest.fn().mockResolvedValue(enterpriseOf()),
    save: jest.fn((e: EnterpriseEntity) => Promise.resolve({ ...e, id: '1' })),
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    find: jest.fn().mockResolvedValue([]),
  };
  const users = {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  };
  const tokens = { revokeAllSessions: jest.fn().mockResolvedValue(2) };
  const password = { hash: jest.fn().mockResolvedValue('hashed'), verify: jest.fn().mockResolvedValue(true) };

  const dataSource = { transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb(manager)) };

  const service = new EnterpriseService(
    enterprises as never,
    users as never,
    dataSource as never,
    password as never,
    tokens as never,
  );

  return { service, enterprises, users, manager, tokens, password };
}

async function expectBizCode(run: () => Promise<unknown>, code: ErrorCode): Promise<void> {
  let thrown: unknown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BizException);
  expect((thrown as BizException).code).toBe(code);
}

/* ────────────────── 建企业 ────────────────── */

describe('EnterpriseService.createEnterprise（流程①）', () => {
  it('编码重复 → 2013（专用码，前端可精确提示）', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(enterpriseOf({ code: 'acme' }));
    await expectBizCode(
      () => h.service.createEnterprise({ code: 'acme', name: 'X' }, 'admin-1'),
      ErrorCode.ENTERPRISE_CODE_EXISTS,
    );
  });

  it('新建企业一律 pending、所有者留空（先建企业再指定所有者，破除循环依赖）', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(null);
    const view = await h.service.createEnterprise({ code: 'acme', name: '云存储公司' }, 'admin-1');

    expect(view.status).toBe(EnterpriseStatus.PENDING);
    expect(view.owner_user_id).toBeNull();
    expect(view.code).toBe('acme');
  });

  it('不创建任何角色——服务层不应触碰角色表（角色由云存储侧惰性初始化）', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(null);
    await h.service.createEnterprise({ code: 'acme', name: '云存储公司' }, 'admin-1');

    // 只有 enterprise 一次 save；没有任何"复制角色模板"的写入
    expect(h.enterprises.save).toHaveBeenCalledTimes(1);
    expect(h.manager.save).not.toHaveBeenCalled();
  });
});

/* ────────────────── 指定 / 移交所有者 ────────────────── */

describe('EnterpriseService.assignOwner（流程②的四条资格校验）', () => {
  it('企业不存在 → 2007', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(null);
    await expectBizCode(() => h.service.assignOwner('1', 'u-1', 'admin-1'), ErrorCode.ENTERPRISE_UNAVAILABLE);
  });

  it('目标账号是平台管理员 → 1001', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(enterpriseOf());
    h.users.findOne.mockResolvedValue(userOf({ role: UserRole.ADMIN }));
    await expectBizCode(() => h.service.assignOwner('1', 'u-1', 'admin-1'), ErrorCode.PARAM_INVALID);
  });

  it('目标账号已属于别的企业 → 2008', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(enterpriseOf());
    h.users.findOne.mockResolvedValue(userOf({ userType: UserType.ENTERPRISE_STAFF, enterpriseId: '999' }));
    await expectBizCode(
      () => h.service.assignOwner('1', 'u-1', 'admin-1'),
      ErrorCode.USER_ALREADY_IN_ENTERPRISE,
    );
  });

  it('目标账号被禁用 → 1001', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(enterpriseOf());
    h.users.findOne.mockResolvedValue(userOf({ status: UserStatus.DISABLED }));
    await expectBizCode(() => h.service.assignOwner('1', 'u-1', 'admin-1'), ErrorCode.PARAM_INVALID);
  });

  it('首次指定：个人账号被提升为企业员工，企业 pending → active', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(enterpriseOf());
    h.users.findOne.mockResolvedValue(userOf());

    const result = await h.service.assignOwner('1', 'u-1', 'admin-1');

    expect(result.transferred).toBe(false);
    expect(result.status).toBe(EnterpriseStatus.ACTIVE);
    // 1) 提升账号 2) 回填 owner + 置 active
    expect(h.manager.update).toHaveBeenCalledTimes(2);
    const userPatch = h.manager.update.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(userPatch).toEqual({
      userType: UserType.ENTERPRISE_STAFF,
      enterpriseId: '1',
      enterpriseRole: 1,
    });
    const entPatch = h.manager.update.mock.calls[1]?.[2] as Record<string, unknown>;
    expect(entPatch.ownerUserId).toBe('u-1');
    expect(entPatch.status).toBe(EnterpriseStatus.ACTIVE);
  });

  it('已在服务中的企业移交所有者：不擅自改状态，并吊销旧所有者会话', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(
      enterpriseOf({ status: EnterpriseStatus.ACTIVE, ownerUserId: 'old-owner' }),
    );
    h.users.findOne.mockResolvedValue(userOf({ userType: UserType.ENTERPRISE_STAFF, enterpriseId: '1' }));

    const result = await h.service.assignOwner('1', 'u-1', 'admin-1');

    expect(result.transferred).toBe(true);
    expect(h.tokens.revokeAllSessions).toHaveBeenCalledWith('old-owner');
    const entPatch = h.manager.update.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(entPatch.status).toBeUndefined(); // 状态没被顺手改成 active
  });

  it('企业已 disabled 时换所有者 → 不会把企业悄悄激活', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(
      enterpriseOf({ status: EnterpriseStatus.DISABLED, ownerUserId: 'old-owner' }),
    );
    h.users.findOne.mockResolvedValue(userOf({ userType: UserType.ENTERPRISE_STAFF, enterpriseId: '1' }));

    const result = await h.service.assignOwner('1', 'u-1', 'admin-1');
    expect(result.status).toBe(EnterpriseStatus.DISABLED);
  });
});

/* ────────────────── 建员工 ────────────────── */

describe('EnterpriseService.createEnterpriseUser（流程③）', () => {
  it('账号已存在 → 2001', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValue(userOf());
    await expectBizCode(
      () => h.service.createEnterpriseUser('1', { username: 'liming' }),
      ErrorCode.USERNAME_EXISTS,
    );
  });

  it('手机号已注册 → 2002', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(userOf());
    await expectBizCode(
      () => h.service.createEnterpriseUser('1', { username: 'newbie', phone: '13800000001' }),
      ErrorCode.PHONE_REGISTERED,
    );
  });

  it('**企业归属只来自入参（登录态），不来自请求体**', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValue(null);
    h.users.findOneOrFail.mockResolvedValue(userOf({ id: 'new-user', username: 'newbie' }));

    const result = await h.service.createEnterpriseUser('42', { username: 'newbie' });

    const created = h.manager.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(created.enterpriseId).toBe('42');
    expect(created.userType).toBe(UserType.ENTERPRISE_STAFF);
    expect(created.mustChangePassword).toBe(1);
    expect(result.enterprise_id).toBe('42');
    expect(result.must_change_password).toBe(true);
  });

  it('同时建一条 0 余额钱包（管理端用户列表会 JOIN 钱包，缺行会出空值）', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValue(null);
    h.users.findOneOrFail.mockResolvedValue(userOf({ id: 'new-user', username: 'newbie' }));

    await h.service.createEnterpriseUser('1', { username: 'newbie' });

    expect(h.manager.save).toHaveBeenCalledTimes(2);
    const wallet = h.manager.create.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(wallet.userId).toBe('new-user');
  });

  it('初始密码只返回一次，且库里存的是哈希', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValue(null);
    h.users.findOneOrFail.mockResolvedValue(userOf({ id: 'new-user', username: 'newbie' }));

    const result = await h.service.createEnterpriseUser('1', { username: 'newbie' });

    expect(result.initial_password).toHaveLength(12);
    const created = h.manager.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(created.passwordHash).toBe('hashed');
    expect(created.passwordHash).not.toBe(result.initial_password);
  });
});

/* ────────────────── 企业内管理 ────────────────── */

describe('EnterpriseService 企业内管理（跨企业一律按"不存在"处理）', () => {
  it('重置别家企业成员的密码 → 1001', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValue(userOf({ userType: UserType.ENTERPRISE_STAFF, enterpriseId: '999' }));
    await expectBizCode(
      () => h.service.resetEnterpriseUserPassword('1', 'u-1'),
      ErrorCode.PARAM_INVALID,
    );
  });

  it('没有任何企业的账号 → 1001', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValue(userOf());
    await expectBizCode(() => h.service.resetEnterpriseUserPassword('1', 'u-1'), ErrorCode.PARAM_INVALID);
  });

  it('重置本企业成员密码：置首登改密 + 吊销会话', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValue(userOf({ userType: UserType.ENTERPRISE_STAFF, enterpriseId: '1' }));

    const result = await h.service.resetEnterpriseUserPassword('1', 'u-1');

    expect(result.must_change_password).toBe(true);
    expect(result.revoked_sessions).toBe(2);
    const patch = h.users.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.mustChangePassword).toBe(1);
  });

  it('**企业所有者本人不能被停用**（否则企业无人可管）', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValue(userOf({ userType: UserType.ENTERPRISE_STAFF, enterpriseId: '1' }));
    h.enterprises.findOne.mockResolvedValue(enterpriseOf({ status: EnterpriseStatus.ACTIVE, ownerUserId: 'u-1' }));

    await expectBizCode(
      () => h.service.setEnterpriseUserStatus('1', 'u-1', UserStatus.DISABLED),
      ErrorCode.PARAM_INVALID,
    );
  });

  it('停用普通员工：吊销会话', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValue(userOf({ userType: UserType.ENTERPRISE_STAFF, enterpriseId: '1' }));
    h.enterprises.findOne.mockResolvedValue(enterpriseOf({ status: EnterpriseStatus.ACTIVE, ownerUserId: 'owner-x' }));

    const result = await h.service.setEnterpriseUserStatus('1', 'u-1', UserStatus.DISABLED);

    expect(result.status).toBe(UserStatus.DISABLED);
    expect(result.revoked_sessions).toBe(2);
    expect(result.is_owner).toBe(false);
  });

  it('恢复员工不吊销会话（启用不恢复登录态）', async () => {
    const h = harness();
    h.users.findOne.mockResolvedValue(userOf({ userType: UserType.ENTERPRISE_STAFF, enterpriseId: '1' }));
    h.enterprises.findOne.mockResolvedValue(enterpriseOf({ status: EnterpriseStatus.ACTIVE, ownerUserId: 'owner-x' }));

    const result = await h.service.setEnterpriseUserStatus('1', 'u-1', UserStatus.NORMAL);

    expect(result.revoked_sessions).toBe(0);
    expect(h.tokens.revokeAllSessions).not.toHaveBeenCalled();
  });
});

/* ────────────────── 初始密码 ────────────────── */

describe('generateInitialPassword', () => {
  it('长度 12，且必含小写、大写、数字、符号各至少一个', () => {
    for (let i = 0; i < 200; i += 1) {
      const pwd = generateInitialPassword();
      expect(pwd).toHaveLength(12);
      expect(pwd).toMatch(/[a-z]/);
      expect(pwd).toMatch(/[A-Z]/);
      expect(pwd).toMatch(/[2-9]/);
      expect(pwd).toMatch(/[!@#$%]/);
    }
  });

  it('不含易混字符 0 O 1 l I', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateInitialPassword()).not.toMatch(/[0O1lI]/);
    }
  });

  it('200 次不重复（randomInt 而非 Math.random）', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateInitialPassword()));
    expect(set.size).toBe(200);
  });
});
