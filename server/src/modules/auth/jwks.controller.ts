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
@Public()
@RawResponse()
@Controller('.well-known')
export class JwksController {
  constructor(private readonly jwks: JwksService) {}

  @Get('jwks.json')
  list(): { keys: unknown[] } {
    return this.jwks.list();
  }
}
