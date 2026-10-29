import { Repository } from 'typeorm';

import { PortalConfigService } from '../../config/portal-config.service';
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
    orderService as unknown as OrderService,
    config,
  );
  return { service, orders, users, orderService };
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
