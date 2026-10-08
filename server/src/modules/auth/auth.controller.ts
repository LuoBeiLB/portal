import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { AuthRateLimit } from '../../common/auth-rate-limit';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { extractBearerToken } from '../../common/request.util';
import { PortalConfigService } from '../../config/portal-config.service';
import { AuthService, AuthTokens } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwksService } from './jwks.service';

export const REFRESH_COOKIE = 'refresh_token';
/** 契约 §1.2：Path=/api/auth/refresh */
export const REFRESH_COOKIE_PATH = '/api/auth/refresh';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly jwks: JwksService,
    private readonly config: PortalConfigService,
    private readonly rateLimit: AuthRateLimit,
  ) {}

  /** 契约 §1.1 注册：注册即建钱包，注册后自动登录（响应同 1.2 成功结构） */
  @Public()
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    await this.rateLimit.enforce(
      request,
      'register',
      this.config.security.authRateLimit.windowSeconds,
      this.config.security.authRateLimit.max,
    );

    const result = await this.auth.register(dto);
    setRefreshCookie(response, result.tokens, this.config.jwt.refreshTtlSeconds, this.config.isProduction());

    // 契约 §1.1 的成功 data 是用户档案；同时返回 token 以支持「注册后自动登录」
    return {
      ...result.profile,
      access_token: result.tokens.access_token,
      expires_in: result.tokens.expires_in,
      user: result.user,
    };
  }

  /** 契约 §1.2 登录 */
  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    await this.rateLimit.enforce(
      request,
      'login',
      this.config.security.authRateLimit.windowSeconds,
      this.config.security.authRateLimit.max,
    );

    const result = await this.auth.login(dto);
    setRefreshCookie(response, result.tokens, this.config.jwt.refreshTtlSeconds, this.config.isProduction());

    return {
      access_token: result.tokens.access_token,
      expires_in: result.tokens.expires_in,
      user: result.user,
    };
  }

  /** 契约 §1.3 刷新：依赖 refresh Cookie；失败 1002 需重新登录 */
  @Public()
  @Post('refresh')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const raw = (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    const result = await this.auth.refresh(raw);
    // refresh 不轮换：把同一个 token 续期写回，保持 14 天滑动窗口
    setRefreshCookie(response, result, this.config.jwt.refreshTtlSeconds, this.config.isProduction());
    return {
      access_token: result.access_token,
      expires_in: result.expires_in,
      user: result.user,
    };
  }

  /** 契约 §1.4 登出：吊销 refresh（并按可选收紧吊销当前 access）；access 2h 自然过期 */
  @Post('logout')
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    const accessToken = extractBearerToken(request) ?? undefined;
    const result = await this.auth.logout(user.id, accessToken, expOf(accessToken));
    response.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return result;
  }
}

/** 读出 access token 的 exp（秒），用于精确设置吊销键 TTL；解析失败返回 undefined 走默认 TTL */
function expOf(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof decoded.exp === 'number' ? decoded.exp : undefined;
  } catch {
    return undefined;
  }
}

function setRefreshCookie(
  response: Response,
  tokens: Pick<AuthTokens, 'refresh_token'>,
  maxAgeSeconds: number,
  secure: boolean,
): void {
  response.cookie(REFRESH_COOKIE, tokens.refresh_token, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: maxAgeSeconds * 1000,
  });
}
