import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { ErrorCode } from './error-code';
import { ResponseInterceptor, withBizCode } from './response.interceptor';

const ctx = {} as ExecutionContext;

function handlerOf<T>(value: T): CallHandler<T> {
  return { handle: () => of(value) } as CallHandler<T>;
}

describe('ResponseInterceptor（契约 §0.2 / §0.5）', () => {
  const interceptor = new ResponseInterceptor<unknown>();

  it('普通返回值包装成 {code:0,message:"ok",data}', async () => {
    const result = await firstValueFrom(
      interceptor.intercept(ctx, handlerOf({ order_id: 10023, order_no: 'O20260930-000123' })),
    );
    expect(result).toEqual({
      code: ErrorCode.OK,
      message: 'ok',
      data: { order_id: 10023, order_no: 'O20260930-000123' },
    });
  });

  it('null/undefined 也返回 data:null 而不是省略字段', async () => {
    const result = await firstValueFrom(interceptor.intercept(ctx, handlerOf(null)));
    expect(result).toEqual({ code: ErrorCode.OK, message: 'ok', data: null });
  });

  it('分页形态原样透传（handler 自行组装 list/total/page/size）', async () => {
    const page = { list: [{ id: 1 }], total: 57, page: 1, size: 20 };
    const result = await firstValueFrom(interceptor.intercept(ctx, handlerOf(page)));
    expect(result.data).toEqual(page);
  });

  it('withBizCode 可显式指定业务码（幂等重复 3003）', async () => {
    const payload = withBizCode(
      ErrorCode.IDEMPOTENT_REPEATED,
      { balance_after: 14000, transaction_id: 9001, idempotent_repeated: true },
      'duplicate bill_no',
    );
    const result = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    expect(result).toEqual({
      code: 3003,
      message: 'duplicate bill_no',
      data: { balance_after: 14000, transaction_id: 9001, idempotent_repeated: true },
    });
  });

  it('不会有 __bizCode/__bizMessage 泄漏到 data 里', async () => {
    const payload = withBizCode(3003, { idempotent_repeated: true });
    const result = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    expect(Object.keys(result.data as object)).toEqual(['idempotent_repeated']);
  });
});
