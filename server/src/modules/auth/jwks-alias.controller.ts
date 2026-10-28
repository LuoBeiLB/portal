import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '../../common/auth/public.decorator';
import { RawResponse } from '../../common/auth/raw-response.decorator';
import { JwksService } from './jwks.service';

/**
 * JWKS 的 **`/api` 别名**：`GET /api/.well-known/jwks.json`。
 *
 * ## 为什么需要它
 *
 * 标准路径是 `/.well-known/jwks.json`（在全局前缀之外，见 main.ts 的 exclude）。
 * 但实际对接时，产品方（云手机）按"门户所有接口都在 /api 下"的直觉拼了
 * `/api/.well-known/jwks.json`，直接拉会 **404**，而且要每个产品单独交代一遍路径。
 *
 * 与其靠口头约定，不如把两条路径都挂上 —— 返回内容完全一致。
 *
 * 实现要点：全局前缀 `api` 会把这个路由拼成 `/api/api/...`，
 * 所以 `main.ts` 的 exclude 里也要登记 `api/.well-known/jwks.json`。
 */
@ApiExcludeController()
@Controller('api/.well-known')
export class JwksAliasController {
  constructor(private readonly jwks: JwksService) {}

  @Public()
  @RawResponse()
  @Get('jwks.json')
  list(): { keys: unknown[] } {
    return this.jwks.list();
  }
}
