import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 订单项状态（契约 §2.3）：0 待支付 1 已支付 2 开通成功 3 失败待退款 4 已退款 */
export enum OrderItemStatus {
  PENDING = 0,
  PAID = 1,
  PROVISIONED = 2,
  FAILED_PENDING_REFUND = 3,
  REFUNDED = 4,
}

/**
 * o_order_item 订单项。
 *
 * **本表主键 id 就是契约里的 `order_item_id`**，它是产品 `POST /internal/provision` 的幂等键，
 * 产品侧必须对其持久化唯一索引（契约 §5.2）。
 *
 * `price_cents` 为下单时快照：产品调价不影响已下单订单的展示与对账口径。
 */
@Entity('o_order_item')
@Index('idx_item_order', ['orderId'])
@Index('idx_item_user_created', ['userId', 'createdAt'])
export class OrderItemEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '即契约 order_item_id（provision 幂等键）' })
  id!: string;

  @Column({ name: 'order_id', type: 'bigint', unsigned: true })
  orderId!: string;

  @Column({ name: 'user_id', type: 'char', length: 36, comment: '冗余，便于按用户查询' })
  userId!: string;

  @Column({ name: 'product_code', type: 'varchar', length: 32 })
  productCode!: string;

  @Column({ name: 'sku_id', type: 'varchar', length: 64 })
  skuId!: string;

  @Column({ name: 'quantity', type: 'int', default: 1, comment: '云手机单笔限 3' })
  quantity!: number;

  @Column({ name: 'price_cents', type: 'bigint', comment: '下单时快照价，单位：分' })
  priceCents!: string;

  @Column({
    name: 'status',
    type: 'smallint',
    default: OrderItemStatus.PENDING,
    comment: '0 待支付 1 已支付 2 开通成功 3 失败待退款 4 已退款',
  })
  status!: OrderItemStatus;

  @Column({ name: 'instance_id', type: 'varchar', length: 64, nullable: true, comment: '产品 provision 返回的实例 id' })
  instanceId!: string | null;

  @Column({ name: 'expire_at', type: 'datetime', precision: 3, nullable: true, comment: '产品 provision 返回的到期时间' })
  expireAt!: Date | null;

  @Column({ name: 'fail_reason', type: 'varchar', length: 64, nullable: true, comment: '如 OUT_OF_STOCK / INSUFFICIENT_BALANCE' })
  failReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}
