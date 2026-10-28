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
    offset: jest.Mock;
    limit: jest.Mock;
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
    offset: jest.fn(),
    limit: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
  };
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  qb.orderBy.mockReturnValue(qb);
  qb.addOrderBy.mockReturnValue(qb);
  qb.offset.mockReturnValue(qb);
  qb.limit.mockReturnValue(qb);

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

  it('limit 默认 50，可覆盖；offset 默认 0', async () => {
    const h = harness([userOf()]);
    await h.controller.list({ enterprise_id: '1' });
    expect(h.qb.limit).toHaveBeenCalledWith(50);
    expect(h.qb.offset).toHaveBeenCalledWith(0);

    const h2 = harness([userOf()]);
    await h2.controller.list({ enterprise_id: '1', limit: 10, offset: 20 });
    expect(h2.qb.limit).toHaveBeenCalledWith(10);
    expect(h2.qb.offset).toHaveBeenCalledWith(20);
  });

  it('排序与门户管理端一致：created_at ASC（加入顺序）', async () => {
    const h = harness([userOf()]);
    await h.controller.list({ enterprise_id: '1' });
    expect(h.qb.orderBy).toHaveBeenCalledWith('u.created_at', 'ASC');
    expect(h.qb.addOrderBy).toHaveBeenCalledWith('u.id', 'ASC');
  });

  it('响应回显 offset，便于产品侧判断还有没有下一页', async () => {
    const h = harness([userOf()]);
    const result = await h.controller.list({ enterprise_id: '1', offset: 40 });
    expect(result.offset).toBe(40);
  });

  it('响应只含展示必需字段，**不含**余额/密码哈希/角色', async () => {
    const h = harness([userOf()]);
    const result = await h.controller.list({ enterprise_id: '1' });

    const item = result.list[0] as unknown as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(
      [
        'enterprise_id',
        'enterprise_role',
        'is_owner',
        'phone',
        'portal_user_id',
        'status',
        'user_type',
        'username',
      ].sort(),
    );
    expect(item.portal_user_id).toBe('u-1');
    expect(item.enterprise_id).toBe('1');
  });

  it('企业角色与主管理员标识正确映射（产品侧据此标出管理员）', async () => {
    const admin = userOf({ id: 'u-admin' });
    (admin as unknown as Record<string, unknown>).enterpriseRole = 1;
    const h = harness([admin]);
    h.enterprises.findOne.mockResolvedValue(enterpriseOf({ ownerUserId: 'u-admin' }));

    const result = await h.controller.list({ enterprise_id: '1' });
    expect(result.list[0]?.enterprise_role).toBe(1);
    expect(result.list[0]?.is_owner).toBe(true);

    /* 普通成员：er=0 且不是 owner */
    const member = userOf({ id: 'u-member' });
    (member as unknown as Record<string, unknown>).enterpriseRole = 0;
    const h2 = harness([member]);
    h2.enterprises.findOne.mockResolvedValue(enterpriseOf({ ownerUserId: 'u-admin' }));
    const r2 = await h2.controller.list({ enterprise_id: '1' });
    expect(r2.list[0]?.enterprise_role).toBe(0);
    expect(r2.list[0]?.is_owner).toBe(false);
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
