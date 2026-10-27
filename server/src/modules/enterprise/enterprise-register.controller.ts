import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';

import { Public } from '../../common/auth/public.decorator';
import { RegisterEnterpriseDto } from './dto/enterprise.dto';
import { EnterpriseRegisteredView } from './dto/enterprise.vo';
import { EnterpriseService } from './enterprise.service';

/**
 * 企业自助注册（**C 端，免登录**）。对应 `docs/23` 图①。
 *
 * 为什么免登录：企业方还没账号 —— 注册时**同时建出**企业和管理员账号。
 * 这也是它比"先注册个人账号再开通企业"更干净的地方：不存在"个人余额怎么处理"。
 *
 * ⚠️ 这是公开接口，必须靠**审核**兜底（不是靠限流）：注册出来是 `pending`，
 * 平台审核通过才 `active`。所以恶意注册不会立刻产生可用资源。
 */
@ApiTags('企业注册 enterprise')
@Controller('enterprise')
export class EnterpriseRegisterController {
  constructor(private readonly enterprise: EnterpriseService) {}

  @ApiOperation({
    summary: '企业自助注册（免登录）',
    description:
      '一次提交同时建出：企业（`pending`）+ 企业管理员账号（`enterprise_role=1`）+ 钱包。\n\n' +
      '**注册不等于可用** —— 必须等平台审核通过（`/api/admin/enterprises/{id}/approve`）。\n' +
      '审核前该账号登录会返回 `2011`。\n\n' +
      '错误：`2013` 企业编码已存在 ｜ `2014` 管理员账号已被占用（与 C 端个人用户共用命名空间）｜ `1001` 参数校验。',
  })
  @ApiOkResponse({ description: '注册结果（固定 pending）', type: EnterpriseRegisteredView })
  @Public()
  @Post('register')
  @HttpCode(200)
  async register(@Body() dto: RegisterEnterpriseDto): Promise<EnterpriseRegisteredView> {
    return this.enterprise.register(dto);
  }
}
