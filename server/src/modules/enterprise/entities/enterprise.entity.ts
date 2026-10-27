import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 企业状态（`enterprise.status`，VARCHAR + 应用层联合类型，不用 MySQL ENUM）。
 *
 * 四个状态构成一个简单状态机（见 docs/23 图①）：
 *
 * ```
 * 用户端注册 → PENDING ──平台通过──→ ACTIVE ──平台停用──→ DISABLED
 *                  │                    ↑                   │
 *                  └──平台驳回──→ REJECTED ──平台可重新通过──┘
 * ```
 */
export enum EnterpriseStatus {
  /**
   * 已注册、**等待平台审核**。
   *
   * 这个状态是 v2 的核心：企业自助注册，不能自己就把自己变成可用 ——
   * 否则平台对它一无所知（谁注册的、真不真实）。
   *
   * `pending` 企业登录报 `2011`，企业端接口一律拒绝。
   */
  PENDING = 'pending',

  /** 正常服务。注册审核通过、或平台停用后恢复，都在这个状态 */
  ACTIVE = 'active',

  /**
   * **审核未通过**（v2 新增）。驳回必须带原因，登录报 `2012` 且 message 回显原因。
   *
   * 平台可以在同一条记录上"重新通过"，但不做企业自助重提 ——
   * 避免有人靠反复提交绕过审核。
   */
  REJECTED = 'rejected',

  /** 平台停用（欠费 / 违规 / 客户要求）。**永不物理删除**，数据与审计全部保留 */
  DISABLED = 'disabled',
}

/**
 * 企业内角色（`u_user.enterprise_role`）。
 *
 * **判"能不能进企业视图"只看这个字段**（配合企业 `status = active`），
 * 不看 `enterprise.owner_user_id` —— 后者只是"创建者/主管理员"，用来定资源归属和将来转让。
 *
 * 为什么要有这一层：一个企业将来可以有**多个管理员**。用布尔字段（是不是 owner）
 * 表达的话，扩到多管理员就得改数据模型。
 */
export enum EnterpriseRole {
  /** 企业普通成员：能被分配资源，不能管人、不能进管理端 */
  MEMBER = 0,
  /** 企业管理员：能管本企业员工、能进管理端企业视图 */
  ADMIN = 1,
}

/**
 * `enterprise` 企业（租户根）。
 *
 * 门户侧的 enterprise **只承载身份归属与审核状态**，不承载产品内的组织
 * （部门 / 角色 / 数据权限）。那些在云存储侧，见 `docs/21` 与 `docs/18`。
 *
 * ## `owner_user_id` 是什么（v2 已降级）
 *
 * **创建者 / 主管理员**，一个字段两件事：
 *
 * - **资源持有人**：企业全部存储资源包默认挂在他名下（`storage_resource.holder_user_id`）。
 *   **资源归个人，不归企业** —— 归企业就得实现企业钱包、对公转账、账期，
 *   而"企业成员不能充值"的规则会让企业钱包永远是空的。
 * - **付费方**：他是唯一允许自助充值的企业账号（普通成员不能充）。
 *
 * ⚠️ **它不再用于判权**。判"是不是企业管理员"用 `u_user.enterprise_role = 1`。
 */
@Entity('enterprise')
@Index('uk_enterprise_code', ['code'], { unique: true })
@Index('idx_enterprise_status', ['status'])
@Index('idx_enterprise_owner', ['ownerUserId'])
@Index('idx_enterprise_status_created', ['status', 'createdAt'])
export class EnterpriseEntity {
  /** 自增主键。TypeORM 的 `bigint` 在 MySQL 下**读出来是 string**，全链路按 string 处理 */
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'code', type: 'varchar', length: 64, comment: '企业编码，对接用；建好后不可改' })
  code!: string;

  @Column({ name: 'name', type: 'varchar', length: 128, comment: '企业名称' })
  name!: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 64, nullable: true, comment: '注册联系人' })
  contactName!: string | null;

  @Column({ name: 'contact_phone', type: 'varchar', length: 32, nullable: true, comment: '注册联系电话' })
  contactPhone!: string | null;

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true, comment: '注册备注（企业方填写）' })
  remark!: string | null;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    default: EnterpriseStatus.PENDING,
    comment: 'pending 待审核 / active 正常 / rejected 已驳回 / disabled 已停用',
  })
  status!: EnterpriseStatus;

  @Column({ name: 'reviewed_at', type: 'datetime', precision: 3, nullable: true, comment: '审核时间' })
  reviewedAt!: Date | null;

  @Column({
    name: 'reviewed_by',
    type: 'char',
    length: 36,
    nullable: true,
    comment: '审核人（平台管理员 u_user.id）',
  })
  reviewedBy!: string | null;

  @Column({
    name: 'reject_reason',
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: '驳回原因（驳回必填），登录时回显给企业方',
  })
  rejectReason!: string | null;

  /**
   * 创建者 / 主管理员（`u_user.id`）。
   *
   * **允许为空**：注册事务里先建企业、再回填（同一事务，对外不可见中间态）。
   * 存量数据里可能为空，所以不要设 NOT NULL。
   */
  @Column({
    name: 'owner_user_id',
    type: 'char',
    length: 36,
    nullable: true,
    comment: '创建者/主管理员 = 资源持有人 + 付费方；不参与判权',
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

  /** 只有 active 才对外服务 */
  isUsable(): boolean {
    return this.status === EnterpriseStatus.ACTIVE;
  }
}
