import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import { PortalConfigService } from '../../config/portal-config.service';

/**
 * 密码哈希（argon2id）。
 * 参数来自配置（ARGON2_*），默认对齐 OWASP 推荐档：memory 19MiB / time 2 / parallelism 1。
 */
@Injectable()
export class PasswordService {
  constructor(private readonly config: PortalConfigService) {}

  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: this.config.security.argon2.memoryCost,
      timeCost: this.config.security.argon2.timeCost,
      parallelism: this.config.security.argon2.parallelism,
    });
  }

  /** 校验失败不抛异常，返回 false 由调用方统一按 2003 处理（避免账号枚举） */
  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
