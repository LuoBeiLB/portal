import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { InternalServiceAuthGuard } from '../../common/auth/internal-service-auth.guard';
import { ANY_PRODUCT, AllowProducts } from '../../common/auth/allow-products.decorator';
import { ProductScopeGuard } from '../../common/auth/product-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { EnterpriseEntity } from '../enterprise/entities/enterprise.entity';
import { UserEntity } from '../user/entities/user.entity';
import { InternalEnterpriseListQueryDto } from './dto/internal-enterprise.dto';
import {
  InternalEnterpriseBriefView,
  InternalEnterpriseListListView,
} from './dto/internal-enterprise.vo';

/** 默认每页条数 */
const DEFAULT_LIMIT = 50;
/** 单页上限：防止产品侧一次拉全库 */
const MAX_LIMIT = 200;

/**
 * 内网 · 企业清单（产品 → 门户）。
 *
 * ## 为什么需要它（补的是企业版流程的第 0 步）
 *
 * `GET /api/internal/enterprise-accounts` **强制要求 `enterprise_id`**，
 * 所以"平台管理员在产品后台里先看到企业列表、再点进某家看成员"这个流程
 * 一直缺了第一步 —— 拿不到 id 就点不进去。
 *
 * 两个接口的分工：
 *
 * | | 本接口 | `enterprise-accounts` |
 * |---|---|---|
 * | 粒度 | 全部企业（元数据） | 单个企业的成员（含个人信息） |
 * | 谁用 | 平台管理员的产品后台 | 企业管理员 / 平台管理员下钻 |
 *
 * ## 谁能看（重要）
 *
 * 本接口用**服务凭据**鉴权，门户只知道"哪个产品在调"，**不知道背后是哪个用户**。
 * 所以"只有平台管理员能看"这条**必须由产品侧把关**：
 *
 * ```
 * 登录返回 role === 'admin'  → 才显示/允许「企业清单」入口
 * 否则                       → 只查自己那一家（enterprise_id 取登录态）
 * ```
 *
 * 门户能提供的一致性保证：`role=admin` 的账号必然 `user_type=0` 且 `enterprise_id=null`
 * （既不能被指定为企业所有者，也不能被分配进企业），所以产品侧判 `role` 一个字段就够，
 * 另两项当校验用。
 *
 * ## 为什么只返回元数据
 *
 * 企业元数据（编码/名称/状态/人数/到期）的敏感度远低于个人信息。
 * 产品侧要按企业维度做运维统计，但**谁的电话是多少**是另一件事 ——
 * 那必须走 `enterprise-accounts`，且一次只能查一家。**这是唯一的分界线。**
 */
@ApiTags('内网 · 企业清单 internal')
@ApiSecurity('service-bearer')
@Public()
@UseGuards(InternalServiceAuthGuard, ProductScopeGuard)
@AllowProducts(ANY_PRODUCT)
@Controller('internal/enterprises')
export class InternalEnterpriseListController {
  constructor(
    @InjectRepository(EnterpriseEntity)
    private readonly enterprises: Repository<EnterpriseEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  @Get()
  @ApiOperation({
    summary: '企业清单（服务凭据）',
    description: [
      '返回**企业元数据**列表，供平台管理员在产品后台里选择企业。',
      '',
      '- **不含成员信息**；查成员请用 `GET /api/internal/enterprise-accounts?enterprise_id=`',
      "- 鉴权：RS256 服务凭据。门户**无法区分**背后是哪个用户，所以「仅平台管理员可见」",
      "  需要产品侧按登录返回的 `role === 'admin'` 自己控制",
      '- 按创建时间倒序：新企业在前；`offset + returned < total` 时还有下一页',
      '- 只返回 `pending`/`rejected`/`disabled` 的企业也可查（默认不过滤状态），便于运营排查',
    ].join('\n'),
  })
  @ApiOkResponse({ type: InternalEnterpriseListListView, description: '企业清单（仅元数据）' })
  async list(@Query() query: InternalEnterpriseListQueryDto): Promise<InternalEnterpriseListListView> {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = query.offset ?? 0;

    const qb = this.enterprises.createQueryBuilder('e');
    if (query.status) {
      qb.andWhere('e.status = :status', { status: query.status });
    }
    if (query.keyword) {
      /* 编码或名称模糊匹配。转义 LIKE 通配符，否则用户输入一个 % 就变成全匹配 */
      const escaped = query.keyword.replace(/[%_\\]/g, (ch) => `\\${ch}`);
      qb.andWhere('(e.code LIKE :kw OR e.name LIKE :kw)', { kw: `%${escaped}%` });
    }

    const total = await qb.getCount();
    const rows = await qb
      .orderBy('e.createdAt', 'DESC')
      .addOrderBy('e.id', 'DESC')
      .skip(offset)
      .take(limit)
      .getMany();

    /* 人数：一次 group by 拿全，避免 N+1 */
    let counts = new Map<string, number>();
    if (rows.length > 0) {
      const ids = rows.map((row) => String(row.id));
      const raw = await this.users
        .createQueryBuilder('u')
        .select('u.enterprise_id', 'enterpriseId')
        .addSelect('COUNT(1)', 'cnt')
        .where('u.enterprise_id IN (:...ids)', { ids })
        .groupBy('u.enterprise_id')
        .getRawMany<{ enterpriseId: string; cnt: string }>();
      counts = new Map(raw.map((item) => [String(item.enterpriseId), Number(item.cnt)]));
    }

    const list: InternalEnterpriseBriefView[] = rows.map((row) => ({
      enterprise_id: String(row.id),
      code: row.code,
      name: row.name,
      status: row.status,
      member_count: counts.get(String(row.id)) ?? 0,
      expire_at: row.expireAt ? toIsoSecond(row.expireAt) : null,
      created_at: toIsoSecond(row.createdAt),
    }));

    return { total, returned: list.length, offset, list };
  }
}

/** 去掉毫秒：契约里时间是 UTC ISO 8601 秒精度，`2026-10-27T02:00:00Z` */
function toIsoSecond(value: Date): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
