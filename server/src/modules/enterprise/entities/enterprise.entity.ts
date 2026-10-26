import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 企业状态（`enterprise.status`，**不是** MySQL ENUM，用 VARCHAR + 应用层联合类型）。
 *
 * 用 VARCHAR 而不是 ENUM 的原因：MySQL 的 ENUM 加值要 `ALTER TABLE`，而这个字段
 * 以后大概率还会加状态（比如 `trial` 试用）。VARCHAR + TS 联合类型的约束力够用，
 * 且迁移成本低。
 */
export enum EnterpriseStatus {
  /**
   * 已建但**还没指定所有者**。
   *
   * 这个状态是必要的：所有者必须是本企业员工（`u_user.user_type=1` 要求 `enterprise_id`
   * 非空），而企业又必须先存在 —— 拆成两步才能破除循环。
   *
   * **`pending` 企业一律不可用**：不能登录、不能调用企业端接口。
   * 不能因为"还没所有者"就放行，那等于给所有 `pending` 企业开了后门。
   */
  PENDING = 'pending',

  /** 正常服务 */
  ACTIVE = 'active',

  /** 停用（欠费 / 到期 / 客户要求）。**永不物理删除**，数据与审计全部保留 */
  DISABLED = 'disabled',
}

/**
 * `enterprise` 企业（租户根）。
 *
 * 门户侧的 enterprise **只承载身份归属**，不承载产品内的组织（部门 / 角色 / 数据权限）。
 * 那些在云存储侧，见 `docs/21` 与 `docs/18`。
 *
 * ## `owner_user_id` 是什么
 *
 * **企业所有者 = 唯一管理员 + 资源默认持有人**，一个字段表达两件事：
 *
 * - 管理权限：产品侧判 `user.id === owner_user_id`，为真直接授予全部权限点（不挂角色）
 * - 资源归属：企业资源包默认都挂在他名下，分配给别人后收回也回他
 *
 * 三条必须实现的校验（见 `docs/24` §2.4）：
 *
 * 1. 所有者**不能被停用或删除**——否则企业无人可管，而字段又不能指向停用账号
 * 2. 换人只能**移交**：改 `owner_user_id`（管理权与资源归属同时走，同一事务）
 * 3. 所有者**必须是本企业员工**（`user_type=1` 且 `enterprise_id` 匹配本企业）
 */
@Entity('enterprise')
@Index('uk_enterprise_code', ['code'], { unique: true })
@Index('idx_enterprise_status', ['status'])
@Index('idx_enterprise_owner', ['ownerUserId'])
export class EnterpriseEntity {
  /** 自增主键。TypeORM 的 `bigint` 在 MySQL 下**读出来是 string**，全链路按 string 处理 */
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'code', type: 'varchar', length: 64, comment: '企业编码，对接用；建好后不可改' })
  code!: string;

  @Column({ name: 'name', type: 'varchar', length: 128, comment: '企业名称' })
  name!: string;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    default: EnterpriseStatus.PENDING,
    comment: 'pending 待指定所有者 / active 正常 / disabled 停用',
  })
  status!: EnterpriseStatus;

  /** 企业总配额（字节，0 = 不限）。注意 TypeORM 的 bigint 读出来是 string */
  @Column({ name: 'quota_bytes', type: 'bigint', default: 0, comment: '企业总配额（字节，0 = 不限）' })
  quotaBytes!: string;

  /**
   * 企业所有者（`u_user.id`）。
   *
   * **必须允许为空**：`pending` 阶段还没有所有者。若设成 NOT NULL，
   * "建企业"那一步就插不进去（见类注释里的先后顺序问题）。
   */
  @Column({
    name: 'owner_user_id',
    type: 'char',
    length: 36,
    nullable: true,
    comment: '企业所有者 = 唯一管理员 + 资源默认持有人；pending 时为空',
  })
  ownerUserId!: string | null;

  @Column({ name: 'expire_at', type: 'datetime', precision: 3, nullable: true, comment: '服务到期时间' })
  expireAt!: Date | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt!: Date;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt!: Date;

  /** 只有 active 才对外服务；pending/disabled 一律拒绝 */
  isUsable(): boolean {
    return this.status === EnterpriseStatus.ACTIVE;
  }
}
