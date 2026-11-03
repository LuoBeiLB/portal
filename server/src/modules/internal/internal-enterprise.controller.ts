import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { InternalServiceAuthGuard } from '../../common/auth/internal-service-auth.guard';
import { ANY_PRODUCT, AllowProducts } from '../../common/auth/allow-products.decorator';
import { ProductScopeGuard } from '../../common/auth/product-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { BizException, ErrorCode } from '../../common/error/error-code';
import { EnterpriseEntity, EnterpriseRole, EnterpriseStatus } from '../enterprise/entities/enterprise.entity';
import { queryEnterpriseMembers } from '../enterprise/enterprise-member.query';
import { UserEntity } from '../user/entities/user.entity';
import { InternalEnterpriseAccountQueryDto } from './dto/internal-enterprise.dto';
import {
  InternalEnterpriseAccountListView,
  InternalEnterpriseAccountView,
} from './dto/internal-enterprise.vo';

/** 默认返回条数：这是"选人"下拉框，不是列表页 */
const DEFAULT_LIMIT = 50;

/**
 * 内网 · 企业成员（产品 → 门户）。
 *
 * ## 为什么需要这个接口
 *
 * 账号的唯一来源是门户（`docs/22` §2.2）：产品侧**不建号、不存密码**。
 * 企业权限管理要挂成员、要挑人加入、要知道谁是管理员——**必须从这里拿**。
 * 没有它，产品侧的「加入成员」只能靠人肉核对账号是否存在。
 *
 * ## 与 `GET /api/enterprise/users` 的关系
 *
 * 两个接口**不是重复**，鉴权轴不同、不能合并成一个：
 *
 * | | 本接口 | `/api/enterprise/users` |
 * |---|---|---|
 * | 调用方 | 产品后端 | 门户管理端（企业管理员，浏览器） |
 * | 鉴权 | RS256 服务凭据 | JWT + `EnterpriseAdminGuard` |
 * | 能查谁 | **任意企业**（产品要服务多企业） | 只能查自己那一家 |
 *
 * 但**底下是同一条查询**（`queryEnterpriseMembers`），保证两边看到的成员集合与顺序一致。
 * 2026-10-27 之前这里是内联写的一份独立实现，排序和字段都与门户那份不同，已收敛。
 *
 * ## 安全约束
 *
 * - 走 **RS256 服务凭据**（`docs/27`），**必须由防火墙/nginx 保证不对公网暴露**
 * - **只返回查询参数指定的那一家企业**的账号，不存在"查全部"的分支
 * - 不返回余额、密码哈希、手机号以外的隐私字段
 *
 * ⚠️ `enterprise_id` 由调用方声明 —— 一把密钥可以查**任意企业**的成员名单。
 * 这是"产品要服务多企业"的必然代价（和 `deduct` 能扣任意用户的钱同类），
 * 前提是内网隔离 + 密钥不外泄。
 *
 * ## 为什么企业不是 active 就直接报 2007
 *
 * `pending` / `rejected` / `disabled` 的企业，其账号**连门户都登录不了**（登录与刷新都会拦）。
 * 把账号返回给产品去"挑人"，只会让人挑完加进产品、结果对方登不进来。
 */
@ApiTags('内网 · 企业成员 internal')
@ApiSecurity('service-bearer')
@Public()
@UseGuards(InternalServiceAuthGuard, ProductScopeGuard)
@AllowProducts(ANY_PRODUCT)
@Controller('internal/enterprise-accounts')
export class InternalEnterpriseAccountController {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(EnterpriseEntity) private readonly enterprises: Repository<EnterpriseEntity>,
  ) {}

  @ApiOperation({
    summary: '拉取某企业的成员（产品侧企业权限管理的数据源）',
    description:
      '产品 → 门户。返回该企业的成员，供产品侧把门户账号挂进自己的企业权限体系。\n\n' +
      '**只返回 `enterprise_id` 指定的那一家企业**；企业不是 `active` 时返回 `2007`。\n\n' +
      '`keyword` 同时匹配登录账号与手机号；`limit` 默认 50、上限 200；`offset` 用于翻页，' +
      '当 `offset + returned < total` 时还有下一页。排序固定 `created_at ASC`（加入顺序）。\n\n' +
      '每个成员带 `enterprise_role`（0 成员 / 1 管理员）与 `is_owner`（主管理员 = 资源持有人/付费方）。\n\n' +
      '错误：`1004` 密钥无效 / 密钥与自报 `product_code` 不一致、`2007` 企业不存在或未激活、`1001` 参数错误。',
  })
  @ApiOkResponse({ description: '统一响应壳，data 为企业成员列表', type: InternalEnterpriseAccountListView })
  @Get()
  async list(@Query() query: InternalEnterpriseAccountQueryDto): Promise<InternalEnterpriseAccountListView> {
    const enterpriseId = query.enterprise_id.trim();

    const enterprise = await this.enterprises.findOne({ where: { id: enterpriseId } });
    if (!enterprise || enterprise.status !== EnterpriseStatus.ACTIVE) {
      throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE);
    }

    const offset = query.offset ?? 0;
    const limit = query.limit ?? DEFAULT_LIMIT;

    /* 与门户管理端共用同一条查询：成员集合与顺序两边一致 */
    const { rows, total } = await queryEnterpriseMembers(this.users, enterpriseId, {
      keyword: query.keyword,
      limit,
      offset,
    });

    const ownerUserId = enterprise.ownerUserId ? String(enterprise.ownerUserId) : null;
    const list: InternalEnterpriseAccountView[] = rows.map((u) => ({
      portal_user_id: u.id,
      username: u.username,
      phone: u.phone,
      enterprise_id: String(u.enterpriseId),
      user_type: u.userType,
      status: u.status,
      enterprise_role: u.enterpriseRole === EnterpriseRole.ADMIN ? EnterpriseRole.ADMIN : EnterpriseRole.MEMBER,
      is_owner: ownerUserId === u.id,
    }));

    return { enterprise_id: enterpriseId, total, returned: list.length, offset, list };
  }
}
