import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { createPublicKey } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';

import { BizException, ErrorCode } from '../../common/error/error-code';
import { JwkKey, kidFingerprint, toJwk } from '../../common/util/jwk.util';
import { PortalConfigService } from '../../config/portal-config.service';
import {
  PORTAL_OWNER,
  SERVICE_KEY_ENABLED,
  ServiceKeyEntity,
} from './entities/service-key.entity';

/** 一把可用的公钥（缓存项） */
export interface ServiceKey {
  ownerCode: string;
  kid: string;
  publicKeyPem: string;
  notBefore: Date | null;
  notAfter: Date | null;
}

/**
 * 强刷防抖窗口：伪造 kid 的请求不能每次都打库。
 *
 * 取 1 秒而不是更长：太长的窗口会挡住"刚插入的新公钥"——
 * 典型场景是运维刚插完一行、产品立刻切到新 kid，若防抖 5 秒，
 * 头几秒的请求会全部被拒（e2e 里就踩到过）。
 * 1 秒仍能把"伪造 kid 打满数据库"压到每秒 1 次查询。
 */
const RELOAD_THROTTLE_MS = 1_000;

/**
 * 服务凭据公钥的加载、缓存与查询（`docs/27` §2.5 / §2.6）。
 *
 * ## 为什么要有缓存
 *
 * 内网接口调用频繁（扣费、查成员），每请求查库不划算。
 * 启动全量加载 → 复用 `ProductSyncService` 的 10 分钟周期刷新 → `kid` 未命中时强刷。
 *
 * ## 为什么强刷要防抖
 *
 * 否则攻击者用一个不存在的 `kid` 反复打内网接口，每次都能触发一次全表查询。
 *
 * ## 启动期还要做一件别的事
 *
 * `ensurePortalKey()`：私钥在文件、公钥在库，两边可能不一致。
 * 启动时用私钥派生公钥，与库里对应 `kid` 的行比对指纹；
 * 库里没有该 `kid` 就自动插入（首次部署），指纹不一致则 **fail-fast**。
 */
@Injectable()
export class ServiceKeyService implements OnModuleInit {
  private readonly logger = new Logger(ServiceKeyService.name);
  private cache = new Map<string, ServiceKey>();
  private lastReloadAt = 0;

  constructor(
    @InjectRepository(ServiceKeyEntity) private readonly keys: Repository<ServiceKeyEntity>,
    private readonly config: PortalConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensurePortalKey();
    await this.reload();
  }

  /**
   * 周期性重载（默认 60 秒，可由 `SERVICE_KEY_RELOAD_INTERVAL_MS` 调整）。
   *
   * 这一条是**停用即时生效的前提**：`resolve()` 命中缓存就直接返回，
   * 不会每请求查库。所以运维把某把公钥 `status` 置 1 之后，
   * 必须有一个周期任务把它从缓存里刷掉 —— 否则会出现"已停用但还能用"。
   *
   * 间隔取 60 秒：表很小（个位数行），全量读的代价可以忽略；
   * 泄漏止血的最坏延迟是一分钟，比"重启门户"快几个数量级。
   */
  @Interval(Number(process.env.SERVICE_KEY_RELOAD_INTERVAL_MS ?? 60_000))
  async periodicReload(): Promise<void> {
    try {
      await this.reload();
    } catch (error) {
      this.logger.error(`服务凭据公钥周期重载失败：${(error as Error).message}`);
    }
  }

  /* ============================================================
     启动一致性校验
     ============================================================ */

  /**
   * 确保 `portal` 当前 `kid` 的公钥在库里，且与文件里的私钥配套。
   *
   * - 库里没有该 `kid` → 用私钥派生公钥自动插入（幂等 bootstrap）
   * - 库里有但指纹不一致 → **启动失败**（否则症状是"签得出来、谁都验不过"）
   *
   * 私钥缺失时跳过（开发环境允许没有密钥），由调用方在真正签名时报错。
   */
  async ensurePortalKey(): Promise<void> {
    const current = this.config.jwt.current;
    if (!current.privateKey) {
      this.logger.warn('JWT 私钥未配置，跳过 portal 公钥注册（签服务凭据时会失败）');
      return;
    }

    const derived = createPublicKey(current.privateKey).export({
      format: 'pem',
      type: 'spki',
    }) as string;
    const kid = current.kid;

    const row = await this.keys.findOne({ where: { kid } });
    if (!row) {
      await this.keys.insert({
        ownerCode: PORTAL_OWNER,
        kid,
        publicKeyPem: derived,
        status: SERVICE_KEY_ENABLED,
        notBefore: null,
        notAfter: null,
        remark: '启动时由私钥自动注册',
      });
      this.logger.log(`已注册门户公钥 kid=${kid} 到 p_service_key`);
      return;
    }

    if (kidFingerprint(derived) !== kidFingerprint(row.publicKeyPem)) {
      throw new Error(
        `私钥与 p_service_key 中的公钥不匹配（kid=${kid}）：` +
          '请检查 JWT_KID 与 JWT_PRIVATE_KEY_FILE 是否指向同一把密钥',
      );
    }
  }

  /* ============================================================
     缓存
     ============================================================ */

  /** 全量重载启用中的公钥（启动、周期刷新、kid 强刷都走这里） */
  async reload(): Promise<void> {
    const rows = await this.keys.find({
      where: { status: SERVICE_KEY_ENABLED, notAfter: IsNull() },
    });
    /* 另外把"设了 not_after 但还没到期"的也算进来 */
    const expiring = await this.keys
      .createQueryBuilder('k')
      .where('k.status = :s', { s: SERVICE_KEY_ENABLED })
      .andWhere('k.not_after IS NOT NULL AND k.not_after > NOW(3)')
      .getMany();

    const next = new Map<string, ServiceKey>();
    for (const row of [...rows, ...expiring]) {
      next.set(row.kid, {
        ownerCode: row.ownerCode,
        kid: row.kid,
        publicKeyPem: row.publicKeyPem,
        notBefore: row.notBefore,
        notAfter: row.notAfter,
      });
    }
    this.cache = next;
    this.lastReloadAt = Date.now();
    this.logger.log(`服务凭据公钥已加载 ${next.size} 把`);
  }

  /** 带防抖的重载：5 秒内最多一次 */
  private async reloadThrottled(): Promise<void> {
    if (Date.now() - this.lastReloadAt < RELOAD_THROTTLE_MS) return;
    await this.reload();
  }

  /* ============================================================
     查询
     ============================================================ */

  /**
   * 按 `kid` 找公钥。缓存未命中 → 强刷一次 → 仍未命中才抛。
   *
   * 强刷是必需的：产品切到新 `kid` 后，若门户只靠 10 分钟周期刷新，
   * 会出现最长 10 分钟的"产品已切、门户还不认"的故障。
   */
  async resolve(kid: string): Promise<ServiceKey> {
    const hit = this.cache.get(kid);
    if (hit && isActive(hit)) return hit;

    await this.reloadThrottled();

    const again = this.cache.get(kid);
    if (!again || !isActive(again)) {
      throw new BizException(ErrorCode.UNAUTHENTICATED);
    }
    return again;
  }

  /** 只接受非门户主体（内网入站用）：门户自己的公钥不能用来调内网接口 */
  async resolveProduct(kid: string): Promise<ServiceKey> {
    const key = await this.resolve(kid);
    if (key.ownerCode === PORTAL_OWNER) {
      throw new BizException(ErrorCode.UNAUTHENTICATED);
    }
    return key;
  }

  /** JWKS 输出：只吐 `owner_code='portal'` 的启用公钥（含轮换期历史公钥） */
  jwks(): { keys: JwkKey[] } {
    const keys: JwkKey[] = [];
    for (const key of this.cache.values()) {
      if (key.ownerCode !== PORTAL_OWNER) continue;
      if (!isActive(key)) continue;
      keys.push(toJwk(key.kid, key.publicKeyPem));
    }
    return { keys };
  }

  /** 运维排查用：当前缓存里的 kid 清单（不含公钥本体） */
  kidList(): Array<{ kid: string; ownerCode: string }> {
    return [...this.cache.values()].map((k) => ({ kid: k.kid, ownerCode: k.ownerCode }));
  }
}

/** 生效窗口判定：status 已在查询里过滤，这里只看到期与未生效 */
function isActive(key: ServiceKey, now = new Date()): boolean {
  if (key.notBefore && key.notBefore.getTime() > now.getTime()) return false;
  if (key.notAfter && key.notAfter.getTime() <= now.getTime()) return false;
  return true;
}