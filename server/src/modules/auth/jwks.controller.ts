import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Controller, Get } from '@nestjs/common';

import { Public } from '../../common/public.decorator';
import { RawResponse } from '../../common/raw-response.decorator';
import { JwksService } from './jwks.service';

/**
 * 契约 §1.5 `GET /.well-known/jwks.json` —— **挂在 /api 前缀之外**，
 * 由 main.ts 的 `setGlobalPrefix('api', { exclude: ['.well-known/jwks.json'] })` 排除。
 *
 * 无鉴权：产品侧在内网直连门户取公钥（启动拉取 + 12h 刷新 + kid 不匹配立即强刷）。
 * 标 @RawResponse()：契约要求返回**标准 JWKS 结构** `{keys:[...]}`，不能套 §0.2 的统一响应壳，
 * 否则产品侧按标准 JWKS 解析会取不到 keys。
 */
@ApiTags('认证 auth')
@Public()
@RawResponse()
@Controller('.well-known')
export class JwksController {
  constructor(private readonly jwks: JwksService) {}

  @ApiOperation({
    summary: 'JWKS 公钥集（契约 §1.5）',
    description:
      '**无鉴权**，产品侧内网直连门户获取。返回标准 JWKS 结构（**不套 `{code,message,data}` 壳**）。\n\n' +
      '会同时列出**当前公钥与轮换期历史公钥**，否则密钥轮换瞬间产品侧验签会全部失败。\n\n' +
      '产品实现要求：启动时拉取 + 每 12h 刷新 + `kid` 不匹配时立即强制刷新。',
  })
  @ApiOkResponse({
    description: '标准 JWKS（注意：没有 code/message/data 外壳）',
    schema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kty: { type: 'string', example: 'RSA' },
              alg: { type: 'string', example: 'RS256' },
              use: { type: 'string', example: 'sig' },
              kid: { type: 'string', example: 'portal-2026-10' },
              n: { type: 'string', description: 'RSA modulus（base64url）' },
              e: { type: 'string', example: 'AQAB' },
            },
          },
        },
      },
    },
  })
  @Get('jwks.json')
  list(): { keys: unknown[] } {
    return this.jwks.list();
  }
}
