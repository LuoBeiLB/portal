import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 开通任务状态 */
export enum ProvisionJobStatus {
  /** 待处理 */
  PENDING = 0,
  /** 已被 worker 认领，处理中 */
  PROCESSING = 1,
  /** 开通成功 */
  SUCCEEDED = 2,
  /** 开通失败，已退款（或已标记失败） */
  FAILED = 3,
}

/**
 * o_provision_job 开通任务队列。
 *
 * 为什么需要它：契约里支付要调产品 `POST /internal/provision`，超时 30s。
 * 若在 HTTP 请求里同步等，并发几单就会把连接池和用户耐心一起耗光。
 * 因此支付只负责「扣费 + 把任务落库」，真正的开通交给后台 worker 逐条推进，
 * 前端轮询订单详情看结果（契约 §2.4 的响应结构不变，仍是按项返回状态）。
 *
 * 幂等：`order_item_id` 唯一 —— 一个订单项只会有一条任务，重复入队被唯一索引挡住。
 */
@Entity('o_provision_job')
@Index('uk_job_order_item', ['orderItemId'], { unique: true })
@Index('idx_job_status_next', ['status', 'nextRunAt'])
export class ProvisionJobEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'order_id', type: 'bigint', unsigned: true })
  orderId!: string;

  @Column({
    name: 'order_item_id',
    type: 'bigint',
    unsigned: true,
    comment: '= o_order_item.id，产品 provision 的幂等键',
  })
  orderItemId!: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId!: string;

  @Column({ name: 'product_code', type: 'varchar', length: 32 })
  productCode!: string;

  @Column({
    name: 'status',
    type: 'smallint',
    default: ProvisionJobStatus.PENDING,
    comment: '0 待处理 1 处理中 2 成功 3 失败',
  })
  status!: ProvisionJobStatus;

  @Column({ name: 'attempts', type: 'int', default: 0, comment: '已尝试次数' })
  attempts!: number;

  @Column({ name: 'max_attempts', type: 'int', default: 3, comment: '最大尝试次数' })
  maxAttempts!: number;

  @Column({ name: 'next_run_at', type: 'datetime', precision: 3, comment: '下次可执行时间（退避用）' })
  nextRunAt!: Date;

  @Column({
    name: 'claimed_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '认领时间，用于判定卡死',
  })
  claimedAt!: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 512, nullable: true })
  lastError!: string | null;

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
}
