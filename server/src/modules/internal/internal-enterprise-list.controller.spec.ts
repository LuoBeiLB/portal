import { Repository } from 'typeorm';

import { EnterpriseEntity } from '../enterprise/entities/enterprise.entity';

import { EnterpriseStatus } from '../enterprise/entities/enterprise.entity';
import { UserEntity } from '../user/entities/user.entity';
import { InternalEnterpriseListController } from './internal-enterprise-list.controller';
import { InternalEnterpriseListQueryDto } from './dto/internal-enterprise.dto';

/**
 * 企业清单接口（平台管理员在产品后台里的第 0 步）。
 *
 * 重点覆盖三件容易出错的事：
 * - `limit` 必须被夹到 200（否则产品侧一次拉全库）
 * - `keyword` 里的 `%`/`_` 必须转义（否则一个 `%` 变成全匹配）
 * - `member_count` 用一次 group by 拿全（N+1 会在企业多时炸）
 */
function makeController(rows: unknown[], counts: Array<{ enterpriseId: string; cnt: string }>) {
  const captured: Record<string, unknown> = {};
  const enterpriseQb = {
    andWhere: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(rows.length),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockImplementation((value: number) => {
      captured.take = value;
      return enterpriseQb;
    }),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  const userQb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(counts),
  };
  const controller = new InternalEnterpriseListController(
    { createQueryBuilder: () => enterpriseQb } as unknown as Repository<EnterpriseEntity>,
    { createQueryBuilder: () => userQb } as unknown as Repository<UserEntity>,
  );
  return { controller, enterpriseQb, captured };
}

function enterprise(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    code: `code-${id}`,
    name: `企业${id}`,
    status: EnterpriseStatus.ACTIVE,
    expireAt: null,
    createdAt: new Date('2026-10-27T02:00:00.123Z'),
    ...overrides,
  };
}

describe('InternalEnterpriseListController（企业清单）', () => {
  it('返回企业元数据 + 人数，时间精确到秒', async () => {
    const { controller } = makeController([enterprise('3')], [{ enterpriseId: '3', cnt: '14' }]);
    const result = await controller.list({} as InternalEnterpriseListQueryDto);

    expect(result.total).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.offset).toBe(0);
    expect(result.list[0]).toEqual({
      enterprise_id: '3',
      code: 'code-3',
      name: '企业3',
      status: EnterpriseStatus.ACTIVE,
      member_count: 14,
      expire_at: null,
      created_at: '2026-10-27T02:00:00Z', // 毫秒必须被裁掉
    });
  });

  it('limit 超过 200 被夹到 200', async () => {
    const { controller, captured } = makeController([], []);
    await controller.list({ limit: 9999 } as InternalEnterpriseListQueryDto);
    expect(captured.take).toBe(200);
  });

  it('不传 limit 时用默认 50', async () => {
    const { controller, captured } = makeController([], []);
    await controller.list({} as InternalEnterpriseListQueryDto);
    expect(captured.take).toBe(50);
  });

  it('没有成员的企业 member_count 补 0（group by 里不会出现该行）', async () => {
    const { controller } = makeController(
      [enterprise('1'), enterprise('2')],
      [{ enterpriseId: '1', cnt: '3' }],
    );
    const result = await controller.list({} as InternalEnterpriseListQueryDto);
    expect(result.list.map((item) => [item.enterprise_id, item.member_count])).toEqual([
      ['1', 3],
      ['2', 0],
    ]);
  });

  it('keyword 里的 LIKE 通配符被转义（输入 % 不会变成全匹配）', async () => {
    const { controller, enterpriseQb } = makeController([], []);
    await controller.list({ keyword: '50%_off' } as InternalEnterpriseListQueryDto);

    const call = enterpriseQb.andWhere.mock.calls.find((args) =>
      String(args[0]).includes('LIKE'),
    );
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual({ kw: '%50\\%\\_off%' });
  });

  it('传 status 时下推为 SQL 条件', async () => {
    const { controller, enterpriseQb } = makeController([], []);
    await controller.list({ status: EnterpriseStatus.PENDING } as InternalEnterpriseListQueryDto);

    const call = enterpriseQb.andWhere.mock.calls.find((args) =>
      String(args[0]).includes('e.status'),
    );
    expect(call?.[1]).toEqual({ status: EnterpriseStatus.PENDING });
  });
});
