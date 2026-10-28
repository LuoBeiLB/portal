import { Injectable } from '@nestjs/common';

import { JwkKey, kidFingerprint, toJwk } from '../../common/util/jwk.util';
import { ServiceKeyService } from '../service-key/service-key.service';

/**
 * JWKS 输出（契约 §1.5）。
 *
 * 2026-10-27 起**公钥来自 `p_service_key` 表**（`owner_code='portal'`），不再读配置文件。
 * 好处是轮换可以拆两步：先插新公钥 → JWKS 立即列出（不重启）→ 再重启切私钥。
 *
 * 契约要求产品侧「启动时拉取 + 每 12h 刷新 + kid 不匹配时立即强制刷新」，
 * 因此这里必须把**当前公钥与轮换期历史公钥都列出来**，否则轮换瞬间产品侧验签全挂。
 */
@Injectable()
export class JwksService {
  constructor(private readonly serviceKeys: ServiceKeyService) {}

  list(): { keys: JwkKey[] } {
    return this.serviceKeys.jwks();
  }
}

export { kidFingerprint, toJwk };