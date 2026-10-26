import { ExecutionContext } from '@nestjs/common';

import { UserRole, UserType } from '../../modules/user/entities/user-status.enum';
import { EnterpriseEntity, EnterpriseStatus } from '../../modules/enterprise/entities/enterprise.entity';
import { AuthUser } from './current-user.decorator';
import { BizException, ErrorCode } from '../error/error-code';
import { EnterpriseOwnerGuard, EnterpriseRequest } from './enterprise-owner.guard';

interface FakeRepo {
  findOne: jest.Mock;
}

function repoReturning(entity: EnterpriseEntity | null): FakeRepo {
  return { findOne: jest.fn().mockResolvedValue(entity) };
}

function contextOf(request: EnterpriseRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as ExecutionContext;
}

function userOf(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'owner-1',
    username: 'zhangguilin',
    role: UserRole.USER,
    userType: UserType.ENTERPRISE_STAFF,
    enterpriseId: '1',
    mustChangePassword: false,
    ...overrides,
  };
}

function enterpriseOf(overrides: Partial<EnterpriseEntity> = {}): EnterpriseEntity {
  return {
    id: '1',
    code: 'acme',
    name: '云存储公司',
    status: EnterpriseStatus.ACTIVE,
    quotaBytes: '0',
    ownerUserId: 'owner-1',
    expireAt: null,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    updatedAt: new Date('2026-10-19T00:00:00Z'),
    ...overrides,
  } as EnterpriseEntity;
}

/** 断言抛出指定业务码（只 await 一次，避免未处理拒绝） */
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

describe('EnterpriseOwnerGuard（判据只有 enterprise.owner_user_id === 当前用户）', () => {
  const build = (entity: EnterpriseEntity | null) => new EnterpriseOwnerGuard(repoReturning(entity) as never);

  it('没有 request.user → 1004（说明漏标了 @Public 或守卫顺序错了）', async () => {
    const guard = build(enterpriseOf());
    await expectBizCode(() => guard.canActivate(contextOf({} as EnterpriseRequest)), ErrorCode.FORBIDDEN);
  });

  it('平台管理员 → 2010（他的权限在 /api/admin/*）', async () => {
    const guard = build(enterpriseOf());
    const req = { user: userOf({ role: UserRole.ADMIN }) } as EnterpriseRequest;
    await expectBizCode(() => guard.canActivate(contextOf(req)), ErrorCode.OWNER_ONLY);
  });

  it('企业员工但 token 没带企业归属 → 2007', async () => {
    const guard = build(enterpriseOf());
    const req = { user: userOf({ enterpriseId: null }) } as EnterpriseRequest;
    await expectBizCode(() => guard.canActivate(contextOf(req)), ErrorCode.ENTERPRISE_UNAVAILABLE);
  });

  it('企业不存在 → 2007', async () => {
    const guard = build(null);
    await expectBizCode(
      () => guard.canActivate(contextOf({ user: userOf() } as EnterpriseRequest)),
      ErrorCode.ENTERPRISE_UNAVAILABLE,
    );
  });

  it.each([EnterpriseStatus.PENDING, EnterpriseStatus.DISABLED])('企业状态 %s → 2007', async (status) => {
    const guard = build(enterpriseOf({ status }));
    await expectBizCode(
      () => guard.canActivate(contextOf({ user: userOf() } as EnterpriseRequest)),
      ErrorCode.ENTERPRISE_UNAVAILABLE,
    );
  });

  it('**不是所有者 → 2010**（核心场景：别家企业的员工进不来）', async () => {
    const guard = build(enterpriseOf({ ownerUserId: 'someone-else' }));
    await expectBizCode(
      () => guard.canActivate(contextOf({ user: userOf() } as EnterpriseRequest)),
      ErrorCode.OWNER_ONLY,
    );
  });

  it('owner_user_id 为 null（pending 残留）→ 2010', async () => {
    const guard = build(enterpriseOf({ ownerUserId: null }));
    await expectBizCode(
      () => guard.canActivate(contextOf({ user: userOf() } as EnterpriseRequest)),
      ErrorCode.OWNER_ONLY,
    );
  });

  it('个人账号（无企业归属）→ 2007', async () => {
    const guard = build(enterpriseOf());
    const req = { user: userOf({ userType: UserType.PERSONAL, enterpriseId: null }) } as EnterpriseRequest;
    await expectBizCode(() => guard.canActivate(contextOf(req)), ErrorCode.ENTERPRISE_UNAVAILABLE);
  });

  it('是所有者且企业 active → 放行，并把企业挂到 request 上（控制器不再查库）', async () => {
    const entity = enterpriseOf();
    const guard = build(entity);
    const req = { user: userOf() } as EnterpriseRequest;

    await expect(guard.canActivate(contextOf(req))).resolves.toBe(true);
    expect(req.enterprise).toBe(entity);
  });

  it('查询条件必须带 id —— 不能写成"取任意一家企业"', async () => {
    const repo = repoReturning(enterpriseOf());
    const guard = new EnterpriseOwnerGuard(repo as never);
    await guard.canActivate(contextOf({ user: userOf() } as EnterpriseRequest));

    expect(repo.findOne).toHaveBeenCalledTimes(1);
    const arg = repo.findOne.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(arg.where).toEqual({ id: '1' });
  });
});
