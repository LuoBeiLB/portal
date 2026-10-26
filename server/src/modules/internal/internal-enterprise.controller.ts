import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { InternalKeyGuard } from '../../common/auth/internal-key.guard';
import { ProductScopeGuard } from '../../common/auth/product-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { BizException, ErrorCode } from '../../common/error/error-code';
import { UserType } from '../user/entities/user-status.enum';
import { UserEntity } from '../user/entities/user.entity';
import { EnterpriseEntity, EnterpriseStatus } from '../enterprise/entities/enterprise.entity';
import { InternalEnterpriseAccountQueryDto } from './dto/internal-enterprise.dto';
import {
  InternalEnterpriseAccountListView,
  InternalEnterpriseAccountView,
} from './dto/internal-enterprise.vo';

/** 默认返回条数：这是"选人"下拉框，不是列表页 */
const DEFAULT_LIMIT = 50;

/**
 * 内网 · 企业账号池（产品 → 门户）。
 *
 * ## 为什么需要这个接口
 *
 * 账号的唯一来源是门户（`docs/22` §2.2）：产品侧**不建号、不存密码**，
 * 企业管理员在"加入成员"时要**从门户的账号池里挑人**，而不是让用户手输账号。
 * 没有它，产品侧的「加入成员」只能靠人肉核对账号是否存在。
 *
 * ## 安全约束
 *
 * - 走 `X-Internal-Key`（`InternalKeyGuard`），**必须由防火墙/nginx 保证不对公网暴露**
 * - **只返回查询参数指定的那一家企业**的账号，不存在"查全部"的分支
 * - 只返回展示必需的字段（不含余额、密码哈希、角色）
 *
 * ## 为什么企业不是 active 就直接报 2007
 *
 * `pending`（还没指定所有者）/ `disabled` 的企业，其账号**连门户都登录不了**
 * （登录与刷新都会拦）。
 * 这种情况下把账号返回给产品去"挑人"，只会让人挑完加进产品、结果对方登不进来。
 * 与其让产品侧自己判，不如这里直接说清。
 */
@ApiTags('内网 · 企业账号 internal')
@ApiSecurity('internal-key')
@Public()
@UseGuards(InternalKeyGuard, ProductScopeGuard)
@Controller('internal/enterprise-accounts')
export class InternalEnterpriseAccountController {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(EnterpriseEntity) private readonly enterprises: Repository<EnterpriseEntity>,
  ) {}

  @ApiOperation({
    summary: '拉取某企业的账号池（产品侧"加入成员"用）',
    description:
      '产品 → 门户。返回该企业的候选账号，供产品侧"把门户账号加入本企业"时挑人。\n\n' +
      '**只返回 `enterprise_id` 指定的那一家企业**；企业不是 `active` 时返回 `2007`。\n\n' +
      '`keyword` 同时匹配登录账号与手机号；`limit` 默认 50、上限 200。\n\n' +
      '错误：`1004` 密钥无效 / 密钥与自报 `product_code` 不一致、`2007` 企业不存在或未激活、`1001` 参数错误。',
  })
  @ApiOkResponse({ description: '统一响应壳，data 为账号池', type: InternalEnterpriseAccountListView })
  @Get()
  async list(@Query() query: InternalEnterpriseAccountQueryDto): Promise<InternalEnterpriseAccountListView> {
    const enterpriseId = query.enterprise_id.trim();

    const enterprise = await this.enterprises.findOne({ where: { id: enterpriseId } });
    if (!enterprise || enterprise.status !== EnterpriseStatus.ACTIVE) {
      throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE);
    }

    const limit = query.limit ?? DEFAULT_LIMIT;

    /* 只查这一家企业；没有"全部企业"的分支，避免任何越界读取的可能 */
    const qb = this.users.createQueryBuilder('u');
    qb.where('u.enterprise_id = :eid', { eid: enterpriseId }).andWhere('u.user_type = :ut', {
      ut: UserType.ENTERPRISE_STAFF,
    });

    const keyword = query.keyword?.trim();
    if (keyword) {
      qb.andWhere('(u.username LIKE :kw OR u.phone LIKE :kw)', { kw: `%${keyword}%` });
    }

    qb.orderBy('u.created_at', 'ASC').addOrderBy('u.id', 'ASC').take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const list: InternalEnterpriseAccountView[] = rows.map((u) => ({
      portal_user_id: u.id,
      username: u.username,
      phone: u.phone,
      enterprise_id: String(u.enterpriseId),
      user_type: u.userType,
      status: u.status,
    }));

    return { enterprise_id: enterpriseId, total, returned: list.length, list };
  }
}
