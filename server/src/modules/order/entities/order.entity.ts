import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** 订单状态（契约 §2.3）：0 待支付 1 部分成功 2 全部成功 3 全部失败 */
export enum OrderStatus {
  PENDING = 0,
  PARTIAL_SUCCESS = 1,
  ALL_SUCCESS = 2,
  ALL_FAILED = 3,
}

/**
 * o_order 订单。
 * `total_cents` 由后端按当前 `p_product` 重算，不信任前端传入价格（契约 §2.2）。
 */
@Entity('o_order')
@Index('uk_order_no', ['orderNo'], { unique: true })
@Index('idx_order_user_created', ['userId', 'createdAt'])
export class OrderEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'order_no', type: 'varchar', length: 40, comment: '如 O20260930-000123' })
  orderNo!: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId!: string;

  @Column({ name: 'total_cents', type: 'bigint', comment: '订单总额，单位：分（后端重算）' })
  totalCents!: string;

  @Column({
    name: 'status',
    type: 'smallint',
    default: OrderStatus.PENDING,
    comment: '0 待支付 1 部分成功 2 全部成功 3 全部失败',
  })
  status!: OrderStatus;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @Column({ name: 'paid_at', type: 'datetime', precision: 3, nullable: true })
  paidAt!: Date | null;

  @Column({
    name: 'paying_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '进入开通阶段的时刻（用于判定"卡在开通中"）',
  })
  payingAt!: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
