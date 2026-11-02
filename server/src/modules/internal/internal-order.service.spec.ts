import { Repository } from 'typeorm';

import { PortalConfigService } from '../../config/portal-config.service';
import { OrderItemEntity } from '../order/entities/order-item.entity';
import { OrderEntity } from '../order/entities/order.entity';
import { OrderService } from '../order/order.service';
import { UserEntity } from '../user/entities/user.entity';
import { UserRole } from '../user/entities/user-status.enum';
import { InternalOrderService } from './internal-order.service';

/**
 * 服务端下单的四条护栏 —— 这里逐条钉死。
 *
 * 这是**钱**的接口：白名单没开时不能扣款、不能买别家商品、不能超上限、
 * 重试不能重复下单。任何一条松动都可能直接造成资损。
 */
type Options = {
  allowed?: string[];
  maxCents?: number;
  dailyMaxCents?: number;
  dailyUsed?: string;
  existing?: Partial<OrderEntity> | null;
  items?: Array<Partial<OrderItemEntity>>;
  detailOrder?: Partial<OrderEntity> | null;
  user?: Partial<UserEntity> | null;
};

function make(options: Options = {}) {
  const orders = {
    findOne: jest.fn().mockResolvedValue(options.existing ?? null),
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total: options.dailyUsed ?? '0' }),
    }),
  };
  const users = {
    findOne: jest
      .fn()
      .mockResolvedValue(options.user === null ? null : { id: 'u1', role: 'user', ...(options.user ?? {}) }),
  };
  const orderItems = {
    find: jest.fn().mockResolvedValue(options.items ?? []),
  };
  const orderService = {
    create: jest.fn().mockResolvedValue({ order_id: '281', total_cents: 80 }),
    pay: jest.fn().mockResolvedValue({
      order_id: '281',
      order_no: 'O20261028-000123',
      status: 1,
      total_cents: 80,
      accepted_items: 1,
      processing_items: 1,
    }),
    viewOf: jest.fn().mockResolvedValue({ order_id: '281', order_no: 'O1', status: 1, total_cents: 80 }),
  };
  const config = {
    shop: {
      serverOrderProducts: options.allowed ?? ['phone'],
      serverOrderMaxCents: options.maxCents ?? 10_000,
      serverOrderDailyMaxCents: options.dailyMaxCents ?? 50_000,
    },
  } as unknown as PortalConfigService;

  const service = new InternalOrderService(
    orders as unknown as Repository<OrderEntity>,
    users as unknown as Repository<UserEntity>,
    orderItems as unknown as Repository<OrderItemEntity>,
    orderService as unknown as OrderService,
    config,
  );
  return { service, orders, users, orderItems, orderService };
}

const phone = { code: 'phone', kid: 'phone-2026-10' } as never;
const dto = {
  portal_user_id: 'u1',
  client_order_key: 'PH-20261028-0001',
  items: [{ product_code: 'phone', sku_id: 'phone-1c2g', quantity: 1 }],
};

describe('InternalOrderService（服务端下单护栏）', () => {
  it('产品未在白名单 → 拒绝，且不碰订单', async () => {
    const { service, orderService } = make({ allowed: [] });
    await expect(service.purchase(phone, dto)).rejects.toThrow(/未开通服务端下单/);
    expect(orderService.create).not.toHaveBeenCalled();
  });

  it('买别家商品 → 拒绝（产品 A 不能买产品 B 的套餐）', async () => {
    const { service } = make();
    await expect(
      service.purchase(phone, { ...dto, items: [{ product_code: 'storage', sku_id: 'x', quantity: 1 }] }),
    ).rejects.toThrow(/只能购买本产品/);
  });

  it('portal_user_id 不存在 → 参数错误', async () => {
    const { service } = make({ user: null });
    await expect(service.purchase(phone, dto)).rejects.toThrow(/portal_user_id 不存在/);
  });

  it('平台管理员不能作为下单用户', async () => {
    const { service } = make({ user: { role: UserRole.ADMIN } });
    await expect(service.purchase(phone, dto)).rejects.toThrow(/平台管理员不能作为下单用户/);
  });

  it('幂等命中：返回首次结果，duplicated=true，不再扣款', async () => {
    const { service, orderService } = make({ existing: { id: '281', userId: 'u1' } });
    const result = await service.purchase(phone, dto);
    expect(result.duplicated).toBe(true);
    expect(orderService.create).not.toHaveBeenCalled();
    expect(orderService.pay).not.toHaveBeenCalled();
  });

  it('幂等键被别的用户占用 → 拒绝（不泄露订单内容）', async () => {
    const { service } = make({ existing: { id: '281', userId: 'other' } });
    await expect(service.purchase(phone, dto)).rejects.toThrow(/幂等键必须按用户唯一/);
  });

  it('今日额度已耗尽 → 拒绝，不下单', async () => {
    const { service, orderService } = make({ dailyMaxCents: 5_000, dailyUsed: '5000' });
    await expect(service.purchase(phone, dto)).rejects.toThrow(/今日服务端下单额度已用尽/);
    expect(orderService.create).not.toHaveBeenCalled();
  });

  it('上限取「单笔」与「今日剩余」的较小者', async () => {
    /* 单笔 10000，日限 50000，今日已用 48000 → 剩余 2000，应传 2000 */
    const { service, orderService } = make({ maxCents: 10_000, dailyMaxCents: 50_000, dailyUsed: '48000' });
    await service.purchase(phone, dto);
    expect(orderService.create).toHaveBeenCalledWith(
      'u1',
      expect.any(Object),
      expect.objectContaining({ clientOrderKey: dto.client_order_key, maxTotalCents: 2_000 }),
    );
  });

  it('正常下单：下单 + 支付一次完成，返回 processing_items 供轮询', async () => {
    const { service, orderService } = make();
    const result = await service.purchase(phone, dto);

    expect(orderService.create).toHaveBeenCalledTimes(1);
    expect(orderService.pay).toHaveBeenCalledWith('u1', '281');
    expect(result).toMatchObject({
      order_id: '281',
      order_no: 'O20261028-000123',
      status: 1,
      total_cents: 80,
      accepted_items: 1,
      processing_items: 1,
      duplicated: false,
    });
  });
});

/**
 * 查询开通结果（产品轮询）。核心是两条过滤：**只返回本产品的项**、
 * 一项都不属于本产品时当订单不存在（不泄露"用户买没买别家"）。
 */
describe('InternalOrderService.detail（查开通结果）', () => {
  const orderRow = {
    id: '281',
    orderNo: 'O20261028-000123',
    userId: 'u1',
    clientOrderKey: 'PH-20261028-0001',
    totalCents: '80',
    status: 1,
    createdAt: new Date('2026-10-28T07:31:09.123Z'),
    paidAt: new Date('2026-10-28T07:31:10.456Z'),
  };
  const item = (over: Record<string, unknown> = {}) => ({
    id: '512',
    skuId: 'phone-1c2g',
    quantity: 1,
    priceCents: '80',
    status: 1,
    instanceId: null,
    expireAt: null,
    failReason: null,
    ...over,
  });

  it('只查本产品的项，且时间精确到秒、未开通时 instance_id 为 null', async () => {
    const { service, orders, orderItems } = make({ items: [item()] });
    orders.findOne.mockResolvedValue(orderRow);

    const result = await service.detail(phone, '281');

    expect(orderItems.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: '281', productCode: 'phone' } }),
    );
    expect(result.returned).toBe(1);
    expect(result.provision_done).toBe(false); // status=1 还要等
    expect(result.items[0]).toMatchObject({ status: 1, instance_id: null, expire_at: null });
    expect(result.created_at).toBe('2026-10-28T07:31:09Z');
    expect(result.paid_at).toBe('2026-10-28T07:31:10Z');
  });

  it('全部项进入终态 → provision_done=true（不必再轮询）', async () => {
    const { service, orders } = make({
      items: [
        item({ id: '512', status: 2, instanceId: 'i-1', expireAt: new Date('2026-11-28T00:00:00.000Z') }),
        item({ id: '513', status: 4, failReason: '余额不足' }),
      ],
    });
    orders.findOne.mockResolvedValue(orderRow);

    const result = await service.detail(phone, '281');
    expect(result.provision_done).toBe(true);
    expect(result.items.map((x) => x.status)).toEqual([2, 4]);
    expect(result.items[0].expire_at).toBe('2026-11-28T00:00:00Z');
    expect(result.items[1].fail_reason).toBe('余额不足');
  });

  it('订单里没有本产品的项 → 4003（不暴露他人订单）', async () => {
    const { service, orders } = make({ items: [] });
    orders.findOne.mockResolvedValue(orderRow);
    await expect(service.detail(phone, '281')).rejects.toThrow();
  });

  it('order_id 不是数字 → 直接 4003，不查库', async () => {
    const { service, orders } = make();
    await expect(service.detail(phone, '281abc')).rejects.toThrow();
    expect(orders.findOne).not.toHaveBeenCalled();
  });

  it('订单不存在 → 4003', async () => {
    const { service, orders } = make();
    orders.findOne.mockResolvedValue(null);
    await expect(service.detail(phone, '999999')).rejects.toThrow();
  });
});

/**
 * 额度判定的语义拆分（2026-11-02 修的 bug）。
 *
 * 旧实现里 `0` 既表示"不限制"（传给 create）又表示"额度用尽"（调用方判），
 * 结果"两个上限都设 0"会被判成用尽 —— 与配置意图正好相反。
 */
describe('InternalOrderService（额度语义）', () => {
  it('两个上限都设 0（都不限制）→ 正常下单，不再误判"额度用尽"', async () => {
    const { service, orderService } = make({ maxCents: 0, dailyMaxCents: 0 });
    const result = await service.purchase(phone, dto);

    expect(result.duplicated).toBe(false);
    expect(orderService.create).toHaveBeenCalledWith(
      'u1',
      expect.any(Object),
      expect.objectContaining({ maxTotalCents: 0 }),
    );
    /* 无上限时不该有 capNote */
    expect(orderService.create.mock.calls[0][2].capNote).toBeUndefined();
  });

  it('日额度用完 → 报错文案给出「今日已用 / 日上限」两个数', async () => {
    const { service } = make({ dailyMaxCents: 5_000, dailyUsed: '5000' });
    await expect(service.purchase(phone, dto)).rejects.toThrow(/今日已用 5000 分.*日上限 5000 分/);
  });

  it('卡住的是日剩余 → capNote 说明是"今日剩余额度"，不是单笔上限', async () => {
    const { service, orderService } = make({ maxCents: 100_000, dailyMaxCents: 50_000, dailyUsed: '30_450'.replace('_', '') });
    await service.purchase(phone, dto);
    const opts = orderService.create.mock.calls[0][2];
    expect(opts.maxTotalCents).toBe(19_550);
    expect(opts.capNote).toContain('今日服务端下单剩余额度');
    expect(opts.capNote).toContain('30450 分');
  });

  it('卡住的是单笔上限 → capNote 说明是"单笔上限"', async () => {
    const { service, orderService } = make({ maxCents: 500, dailyMaxCents: 50_000, dailyUsed: '0' });
    await service.purchase(phone, dto);
    const opts = orderService.create.mock.calls[0][2];
    expect(opts.maxTotalCents).toBe(500);
    expect(opts.capNote).toContain('单笔上限');
  });
});
