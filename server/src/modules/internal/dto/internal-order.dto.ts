import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';

/** 服务端下单的一项 */
export class InternalOrderItemDto {
  @ApiProperty({
    description: '商品 code。**必须等于你的产品 code**（门户强制校验，否则 1004）',
    example: 'phone',
  })
  @IsString()
  @MaxLength(32)
  product_code!: string;

  @ApiProperty({ description: 'SKU id（从 `GET /internal/products` 拿）', example: 'phone-1c2g' })
  @IsString()
  @MaxLength(64)
  sku_id!: string;

  @ApiPropertyOptional({ description: '数量，默认 1（上限按产品配置）', example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  quantity?: number;
}

/**
 * 服务端下单（产品 → 门户）。
 *
 * ## 为什么需要它
 *
 * 产品侧要在自己的 App/Web 里让用户直接买套餐，但产品后端**不一定持有用户的 access token**
 * （用户可能只登录了产品、没登录门户）。这个接口让产品用自己的服务凭据下单，
 * 用 `portal_user_id` 指定"替谁买"。
 *
 * ## 为什么"传用户 id"是可接受的
 *
 * 门户**无法**验证用户是否同意，但信任边界跟 `POST /api/wallet/deduct` 完全一致 ——
 * 那个接口早就能用服务凭据扣任意用户的钱。所以本接口不新增"产品能花用户钱"这个能力，
 * 新增的只是"能买商品、能触发开通"。
 *
 * 因此护栏必须写死：
 *
 * 1. **产品白名单**（`SERVER_ORDER_PRODUCTS`，默认空 = 全禁）
 * 2. **只能买自己的商品**（`product_code` 必须等于凭据的 `iss`）
 * 3. **单笔上限 + 日累计上限**（映射表写错一个 id 时，这决定最坏损失）
 * 4. **`client_order_key` 唯一索引**（重试不会产生第二个订单、不会重复扣款）
 */
export class InternalCreateOrderDto {
  @ApiProperty({
    description: '**门户**用户 id（你的映射表里那个），不是你自己系统的用户 id',
    example: '01a1b2c3-d4e5-6f70-8192-a3b4c5d6e7f8',
  })
  @IsString()
  @MaxLength(36)
  @Matches(/^[0-9a-fA-F-]{32,36}$/, { message: 'portal_user_id 必须是门户返回的用户 id（UUID）' })
  portal_user_id!: string;

  @ApiProperty({
    description:
      '产品侧单号，**幂等键**。同一个 key 重复提交只会产生一个订单，第二次返回首次结果（`duplicated=true`）。\n\n' +
      '建议格式：`<产品前缀>-<业务主键>`，如 `PH-20261028-0001`。',
    example: 'PH-20261028-0001',
    maxLength: 64,
  })
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9._:-]{8,64}$/, {
    message: 'client_order_key 只允许字母/数字/._:- ，长度 8~64',
  })
  client_order_key!: string;

  @ApiProperty({
    description: '购买项。每一项的 `product_code` 必须等于你的产品 code',
    type: [InternalOrderItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => InternalOrderItemDto)
  items!: InternalOrderItemDto[];

  @ApiPropertyOptional({
    description:
      '**推荐的留痕字段**：用户在产品内点击"购买"时产生的确认号（订单预览页的幂等号）。\n' +
      '门户会记进审计日志。不传也能下单，但出争议时你拿不出"用户点过"的证据。',
    example: 'consent-01HQ2X',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  consent_ref?: string;
}
