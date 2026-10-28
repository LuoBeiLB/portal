import { ApiProperty } from '@nestjs/swagger';

/**
 * 账号池里的一个候选账号。
 *
 * 字段刻意精简：产品侧只需要"显示给人挑"，不需要余额、创建时间这些它自己也有。
 */
export class InternalEnterpriseAccountView {
  @ApiProperty({
    description: '门户用户 UUID。产品侧拿它建 `portal_user_map` 映射（**唯一标识，不是 username**）',
    example: '01a11e65-3a34-7578-95a7-ebfdd8cd731c',
  })
  portal_user_id!: string;

  @ApiProperty({ description: '登录账号（展示用；两家企业可以重名，所以不能用它做标识）', example: 'liming' })
  username!: string;

  @ApiProperty({
    type: String,
    description: '手机号；未绑定时为 null',
    nullable: true,
    example: '13800000001',
  })
  phone!: string | null;

  @ApiProperty({ description: '所属企业 id（与请求参数一致）', example: '1' })
  enterprise_id!: string;

  @ApiProperty({
    description: '账号性质：`0` 个人 · `1` 企业员工。这里只会出现 `1`（查询已按企业过滤）',
    enum: [0, 1],
    example: 1,
  })
  user_type!: number;

  @ApiProperty({
    description: '状态：`0` 正常 · `1` 禁用。**产品侧应把禁用账号置灰但仍展示** —— 它可能已经有文件在自家库里',
    enum: [0, 1],
    example: 0,
  })
  status!: number;

  @ApiProperty({
    description:
      '企业内角色：`0` 普通成员 · `1` 企业管理员。' +
      '产品侧做成员列表时用它标出"谁是管理员"。' +
      '⚠️ 它只代表**门户里**的企业管理员身份，不等于你产品内的管理员',
    enum: [0, 1],
    example: 0,
  })
  enterprise_role!: number;

  @ApiProperty({
    description:
      '是否为主管理员（创建者 / **资源持有人 / 付费方**），一个企业只有一个。' +
      '要判断"谁能充值/付费"看这个，不要看 `enterprise_role`',
    example: false,
  })
  is_owner!: boolean;
}

/** 账号池响应 data */
export class InternalEnterpriseAccountListView {
  @ApiProperty({ description: '所属企业 id', example: '1' })
  enterprise_id!: string;

  @ApiProperty({ description: '符合条件的总数（不受 `limit` 影响）', example: 14 })
  total!: number;

  @ApiProperty({ description: '本次返回条数（≤ limit）', example: 12 })
  returned!: number;

  @ApiProperty({ description: '本次跳过的条数（回显请求的 `offset`）', example: 0 })
  offset!: number;

  @ApiProperty({ description: '候选账号列表', type: [InternalEnterpriseAccountView] })
  list!: InternalEnterpriseAccountView[];
}
