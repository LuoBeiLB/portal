import { Repository } from 'typeorm';

import { UserType } from '../user/entities/user-status.enum';
import { UserEntity } from '../user/entities/user.entity';

/** 成员查询参数（两个入口共用） */
export interface EnterpriseMemberQuery {
  /** 模糊匹配登录账号或手机号 */
  keyword?: string;
  limit: number;
  /** 跳过多少条。默认 0；`/api/enterprise/users` 用 page/size 换算 */
  offset?: number;
}

/** 成员查询结果 */
export interface EnterpriseMemberResult {
  rows: UserEntity[];
  /** 满足条件的总数（**不受 limit/offset 影响**），产品侧据此判断还有没有下一页 */
  total: number;
}

/**
 * 查某企业的成员（**两个入口共用这一条查询**）。
 *
 * ## 谁在用
 *
 * | 入口 | 调用方 | 企业归属来源 |
 * |---|---|---|
 * | `GET /api/enterprise/users` | 门户管理端（企业管理员） | JWT 的 `ent`，**不接受传参** |
 * | `GET /api/internal/enterprise-accounts` | 产品后端（云存储等） | query 的 `enterprise_id` |
 *
 * ## 为什么抽成函数而不是两处各写一遍
 *
 * 这两个接口在 2026-10-27 之前是**两份独立实现**（一份在 service、一份内联在 controller），
 * 结果已经漂移：
 *
 * - 排序相反（一处 `created_at DESC`、一处 `ASC`）—— 同一家企业的成员，
 *   企业管理员在门户看到的顺序和产品侧拉到的顺序不一样
 * - 字段不一致（产品侧那条没有企业角色，做不了"谁是管理员"）
 * - 分页能力不一致（一处 page/size、一处只有 limit）
 *
 * 抽成一条查询后，两边的**成员集合与顺序**保证一致，差异只留在各自的出参映射上。
 *
 * ## 排序为什么是 `created_at ASC`
 *
 * 成员列表按"加入顺序"更符合直觉（新人排在后面），也让两边口径统一。
 * 加 `u.id` 作为次级排序键：同一毫秒创建的两个账号顺序才稳定，否则分页会漏/重。
 *
 * ## 为什么强制 `user_type = 1`
 *
 * 企业成员一定是企业员工账号。多加这一条是为了防脏数据：
 * 万一有 `enterprise_id` 有值但 `user_type` 没跟着改的历史行，
 * 它不该出现在"企业成员"里（那会让产品侧挑到一个门户认为是个人用户的人）。
 */
export async function queryEnterpriseMembers(
  users: Repository<UserEntity>,
  enterpriseId: string,
  options: EnterpriseMemberQuery,
): Promise<EnterpriseMemberResult> {
  const qb = users
    .createQueryBuilder('u')
    .where('u.enterprise_id = :eid', { eid: String(enterpriseId) })
    .andWhere('u.user_type = :ut', { ut: UserType.ENTERPRISE_STAFF });

  const keyword = options.keyword?.trim();
  if (keyword) {
    qb.andWhere('(u.username LIKE :kw OR u.phone LIKE :kw)', { kw: `%${keyword}%` });
  }

  qb.orderBy('u.created_at', 'ASC')
    .addOrderBy('u.id', 'ASC')
    .offset(options.offset ?? 0)
    .limit(options.limit);

  const [rows, total] = await qb.getManyAndCount();
  return { rows, total };
}
