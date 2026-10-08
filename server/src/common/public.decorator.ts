import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'portal:isPublic';

/**
 * 标记无需登录即可访问的接口（注册/登录/刷新/JWKS/内网接口自行校验）。
 * 未标记的接口由全局 JwtAuthGuard 要求 `Authorization: Bearer <门户 JWT>`。
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
