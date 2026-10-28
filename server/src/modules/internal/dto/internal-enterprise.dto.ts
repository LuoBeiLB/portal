import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * 产品侧拉取某企业的账号池（`GET /api/internal/enterprise-accounts`）。
 *
 * 用途：产品（云存储）的「加入成员」界面要**从门户挑人**，而不是让用户手输账号。
 * 依据 `docs/24` §1.2：账号的唯一来源是门户，产品侧只查询、不建号。
 *
 * ⚠️ **只返回该企业的账号** —— 产品侧不需要、也不应该看到别家企业的人。
 */
export class InternalEnterpriseAccountQueryDto {
  @ApiProperty({
    description: '企业 id（`enterprise.id`）。**只返回这家企业的账号**，不接受通配',
    example: '1',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  enterprise_id!: string;

  @ApiPropertyOptional({
    description: '按登录账号或手机号模糊搜索（产品侧"加入成员"的搜索框）',
    example: 'li',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({
    description: '最多返回多少条。默认 50，上限 200 —— 这是"选人"用的下拉框，不是列表页',
    example: 50,
    default: 50,
    maximum: 200,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({
    description:
      '跳过多少条，配合 `limit` 做分页（默认 0）。' +
      '当 `offset + returned < total` 时还有下一页；成员按 `created_at ASC` 排序，' +
      '翻页期间有人加入可能边界重复，按 `portal_user_id` 去重即可',
    example: 0,
    default: 0,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
