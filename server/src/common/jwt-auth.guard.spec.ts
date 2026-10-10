import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PortalConfigService } from '../config/portal-config.service';
import { TokenService } from '../modules/auth/token.service';
import { AuthUser } from './current-user.decorator';
import { BizException, ErrorCode } from './error-code';
import { JwtAuthGuard } from './jwt-auth.guard';

interface FakeRequest {
  headers: Record<string, string>;
  user?: AuthUser;
}

function contextOf(request: FakeRequest, isPublic = false): { ctx: ExecutionContext; reflector: Reflector } {
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as ExecutionContext;
  const reflector = { getAllAndOverride: () => isPublic } as unknown as Reflector;
  return { ctx, reflector };
}

function guardOf(reflector: Reflector, verify: (token: string) => Promise<unknown>, revoked = false): JwtAuthGuard {
  const jwt = { verifyAsync: verify } as unknown as JwtService;
  const config = { jwt: { issuer: 'cloud-portal' } } as unknown as PortalConfigService;
  const tokens = { isAccessTokenRevoked: () => Promise.resolve(revoked) } as unknown as TokenService;
  return new JwtAuthGuard(reflector, jwt, config, tokens);
}

describe('JwtAuthGuard（契约 §0.3 / §0.6）', () => {
  it('@Public() 路由直接放行，不要求 token', async () => {
    const { ctx, reflector } = contextOf({ headers: {} }, true);
    const guard = guardOf(reflector, () => Promise.reject(new Error('不应被调用')));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('缺少 Authorization 头 → 1002', async () => {
    const { ctx, reflector } = contextOf({ headers: {} });
    const guard = guardOf(reflector, () => Promise.resolve({}));
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
  });

  it('Bearer 前缀大小写不敏感，token 解析正确并写入 request.user', async () => {
    const request: FakeRequest = { headers: { authorization: 'bearer abc.def.ghi' } };
    const { ctx, reflector } = contextOf(request);
    const guard = guardOf(reflector, (token) => {
      expect(token).toBe('abc.def.ghi');
      return Promise.resolve({ sub: 'user-1', uname: 'luobo' });
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // 2026-10-10 起守卫额外写入 role；旧版 token 没有 role claim → 一律按普通用户（绝不因此放行管理员）
    expect(request.user).toEqual({ id: 'user-1', username: 'luobo', role: 'user' });
  });

  it('JWT 带 role=admin 时写入 request.user.role（管理端鉴权靠它）', async () => {
    const request: FakeRequest = { headers: { authorization: 'Bearer admin-token' } };
    const { ctx, reflector } = contextOf(request);
    const guard = guardOf(reflector, () => Promise.resolve({ sub: 'admin-1', uname: 'admin', role: 'admin' }));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toEqual({ id: 'admin-1', username: 'admin', role: 'admin' });
  });

  it('role 值非法（如伪造 "ADMIN" / 任意字符串）时降级为普通用户', async () => {
    for (const fakeRole of ['ADMIN', 'superuser', '', null]) {
      const request: FakeRequest = { headers: { authorization: 'Bearer t' } };
      const { ctx, reflector } = contextOf(request);
      const guard = guardOf(reflector, () => Promise.resolve({ sub: 'u', uname: 'n', role: fakeRole }));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(request.user?.role).toBe('user');
    }
  });

  it('token 过期 → 1003（前端据此走 refresh）', async () => {
    const { ctx, reflector } = contextOf({ headers: { authorization: 'Bearer expired' } });
    const guard = guardOf(reflector, () => {
      const error = new Error('jwt expired');
      error.name = 'TokenExpiredError';
      return Promise.reject(error);
    });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.TOKEN_EXPIRED });
  });

  it('签名无效 / issuer 不符 → 1002', async () => {
    const { ctx, reflector } = contextOf({ headers: { authorization: 'Bearer tampered' } });
    const guard = guardOf(reflector, () => {
      const error = new Error('invalid signature');
      error.name = 'JsonWebTokenError';
      return Promise.reject(error);
    });
    const thrown = await guard.canActivate(ctx).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(BizException);
    expect((thrown as BizException).code).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it('非 Bearer 方案（如 Basic）→ 1002', async () => {
    const { ctx, reflector } = contextOf({ headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    const guard = guardOf(reflector, () => Promise.resolve({}));
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
  });

  it('token 已登出吊销（Redis 命中）→ 1002，即使签名有效', async () => {
    const request: FakeRequest = { headers: { authorization: 'Bearer valid.but.revoked' } };
    const { ctx, reflector } = contextOf(request);
    const guard = guardOf(reflector, () => Promise.resolve({ sub: 'user-1', uname: 'luobo' }), true);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
    expect(request.user).toBeUndefined();
  });
});
