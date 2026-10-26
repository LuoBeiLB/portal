import { BizException, ErrorCode } from '../../common/error/error-code';
import { UserRole, UserStatus, UserType } from '../user/entities/user-status.enum';
import { UserEntity } from '../user/entities/user.entity';
import { EnterpriseEntity, EnterpriseStatus } from '../enterprise/entities/enterprise.entity';
import { InternalEnterpriseAccountController } from './internal-enterprise.controller';

/* ────────────────── 测试替身 ────────────────── */

function userOf(overrides: Partial<UserEntity> = {}): UserEntity {
  return {
    id: 'u-1',
    username: 'liming',
    phone: '13800000001',
    passwordHash: 'hash',
    role: UserRole.USER,
    userType: UserType.ENTERPRISE_STAFF,
    enterpriseId: '1',
    status: UserStatus.NORMAL,
    mustChangePassword: 1,
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
    status: EnterpriseStatus.ACTIVE,
    ownerUserId: 'owner-1',
    expireAt: null,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    updatedAt: new Date('2026-10-19T00:00:00Z'),
    ...overrides,
  } as EnterpriseEntity;
}

interface Harness {
  controller: InternalEnterpriseAccountController;
  users: { createQueryBuilder: jest.Mock };
  qb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  enterprises: { findOne: jest.Mock };
}

function harness(rows: UserEntity[] = []): Harness {
  const qb: Harness['qb'] = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
  };
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  qb.orderBy.mockReturnValue(qb);
  qb.addOrderBy.mockReturnValue(qb);
  qb.take.mockReturnValue(qb);

  const users = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  const enterprises = { findOne: jest.fn().mockResolvedValue(enterpriseOf()) };

  const controller = new InternalEnterpriseAccountController(users as never, enterprises as never);
  return { controller, users, qb, enterprises };
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

/* ────────────────── 用例 ────────────────── */

describe('InternalEnterpriseAccountController（产品侧拉账号池）', () => {
  it('企业不存在 → 2007', async () => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(null);
    await expectBizCode(() => h.controller.list({ enterprise_id: '99' }), ErrorCode.ENTERPRISE_UNAVAILABLE);
  });

  it.each([EnterpriseStatus.PENDING, EnterpriseStatus.DISABLED])('企业状态 %s → 2007', async (status) => {
    const h = harness();
    h.enterprises.findOne.mockResolvedValue(enterpriseOf({ status }));
    await expectBizCode(() => h.controller.list({ enterprise_id: '1' }), ErrorCode.ENTERPRISE_UNAVAILABLE);
  });

  it('**只查指定企业**：where 必须带 enterprise_id，没有"查全部"的分支', async () => {
    const h = harness([userOf()]);
    await h.controller.list({ enterprise_id: '42' });

    expect(h.enterprises.findOne).toHaveBeenCalledWith({ where: { id: '42' } });
    const firstWhere = h.qb.where.mock.calls[0] as [string, Record<string, unknown>];
    expect(firstWhere[0]).toContain('u.enterprise_id');
    expect(firstWhere[1]).toEqual({ eid: '42' });
  });

  it('只取企业员工（user_type=1），不会把个人账号混进来', async () => {
    const h = harness([userOf()]);
    await h.controller.list({ enterprise_id: '1' });

    const hasUserTypeFilter = h.qb.andWhere.mock.calls.some(
      (c) => String(c[0]).includes('u.user_type') && (c[1] as Record<string, unknown>)?.ut === UserType.ENTERPRISE_STAFF,
    );
    expect(hasUserTypeFilter).toBe(true);
  });

  it('keyword 同时匹配账号与手机号', async () => {
    const h = harness([userOf()]);
    await h.controller.list({ enterprise_id: '1', keyword: ' lim ' });

    const kwCall = h.qb.andWhere.mock.calls.find((c) => String(c[0]).includes('LIKE'));
    expect(kwCall?.[0]).toContain('u.username');
    expect(kwCall?.[0]).toContain('u.phone');
    expect((kwCall?.[1] as Record<string, unknown>)?.kw).toBe('%lim%');
  });

  it('不传 keyword 时不加 LIKE 条件', async () => {
    const h = harness([userOf()]);
    await h.controller.list({ enterprise_id: '1' });

    expect(h.qb.andWhere.mock.calls.some((c) => String(c[0]).includes('LIKE'))).toBe(false);
  });

  it('limit 默认 50，上限由 DTO 校验；这里只验证默认值生效', async () => {
    const h = harness([userOf()]);
    await h.controller.list({ enterprise_id: '1' });
    expect(h.qb.take).toHaveBeenCalledWith(50);

    const h2 = harness([userOf()]);
    await h2.controller.list({ enterprise_id: '1', limit: 10 });
    expect(h2.qb.take).toHaveBeenCalledWith(10);
  });

  it('响应只含展示必需字段，**不含**余额/密码哈希/角色', async () => {
    const h = harness([userOf()]);
    const result = await h.controller.list({ enterprise_id: '1' });

    const item = result.list[0] as unknown as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(
      ['enterprise_id', 'phone', 'portal_user_id', 'status', 'user_type', 'username'].sort(),
    );
    expect(item.portal_user_id).toBe('u-1');
    expect(item.enterprise_id).toBe('1');
  });

  it('返回 total 与 returned 两个口径（total 不受 limit 影响）', async () => {
    const h = harness([userOf(), userOf({ id: 'u-2', username: 'wangfang' })]);
    h.qb.getManyAndCount.mockResolvedValue([[userOf()], 2]);

    const result = await h.controller.list({ enterprise_id: '1', limit: 1 });
    expect(result.total).toBe(2);
    expect(result.returned).toBe(1);
  });

  it('空结果给出空数组而不是 null', async () => {
    const h = harness([]);
    const result = await h.controller.list({ enterprise_id: '1' });
    expect(result.list).toEqual([]);
    expect(result.total).toBe(0);
  });
});
