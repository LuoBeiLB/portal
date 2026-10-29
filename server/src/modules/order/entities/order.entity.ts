import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

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
/* 产品侧单号的唯一索引：服务端下单重试不会产生第二个订单 */
@Index('uk_client_order', ['clientOrderKey'], { unique: true })
export class OrderEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'order_no', type: 'varchar', length: 40, comment: '如 O20260930-000123' })
  orderNo!: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId!: string;

  /**
   * 产品侧单号（服务端下单的幂等键）。用户自助下单为 null。
   *
   * 为什么必须有：产品调 `POST /api/internal/orders` 时，网络超时/进程重启都会触发重试；
   * 没有这个键，一次重试就多一个订单、多扣一次钱。唯一索引是最后一道保险 ——
   * 即使并发两个请求同时进来，也只有一个能写成功。
   */
  @Column({
    name: 'client_order_key',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '产品侧单号（服务端下单幂等键）；用户自助下单为 NULL',
  })
  clientOrderKey!: string | null;

  @Column({ name: 'total_cents', type: 'bigint', comment: '订单总额，单位：分（后端重算）' })
  totalCents!: string;

  @Column({
    name: 'status',
    type: 'smallint',
    default: OrderStatus.PENDING,
    comment: '0 待支付 1 部分成功 2 全部成功 3 全部失败',
  })
  status!: OrderStatus;

  @Column({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
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

  @Column({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt!: Date;
}
