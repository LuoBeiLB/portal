import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { EnterpriseEntity } from '../../modules/enterprise/entities/enterprise.entity';
import { EnterpriseRequest } from './enterprise-admin.guard';

/**
 * 当前企业（由 `EnterpriseAdminGuard` 注入）。
 *
 * 用它的意义：守卫已经查过一次企业，控制器再查一次是浪费；更重要的是
 * **企业 id 的唯一来源就是这里**——绝不能让控制器改成从请求体取。
 */
export const CurrentEnterprise = createParamDecorator((_data: unknown, ctx: ExecutionContext): EnterpriseEntity => {
  const request = ctx.switchToHttp().getRequest<EnterpriseRequest>();
  if (!request.enterprise) {
    throw new Error('CurrentEnterprise 只能在 EnterpriseAdminGuard 之后使用');
  }
  return request.enterprise;
});
