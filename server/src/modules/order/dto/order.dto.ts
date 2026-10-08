import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** 契约 §2.2 下单入参：**不含价格字段**（后端按当前缓存价重算，不信任前端传价） */
export class OrderItemInputDto {
  @ApiProperty({ description: '产品代码', enum: ['storage', 'phone', 'desktop'], example: 'storage' })
  @IsString()
  @MaxLength(32)
  product_code!: string;

  @ApiProperty({ description: '产品内 SKU ID', example: 'storage-500g' })
  @IsString()
  @MaxLength(64)
  sku_id!: string;

  @ApiPropertyOptional({ description: '数量，默认 1；单项最多 10，**云手机（phone）最多 3**', example: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  quantity?: number;
}

export class CreateOrderDto {
  @ApiProperty({
    description: '订单项，1~10 项。**不要传价格**（后端按当前缓存价重算）',
    type: [OrderItemInputDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

/** 契约 §2.1 商品列表查询 */
export class ProductQueryDto {
  @ApiPropertyOptional({ description: '按产品代码过滤', enum: ['storage', 'phone', 'desktop'], example: 'storage' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  product_code?: string;
}

/** 我的订单列表查询（契约外补充） */
export class OrderListQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: '每页条数（上限 100）', example: 20, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;
}

/** 产品账单上报（对账用；产品侧调用，X-Internal-Key） */
export class ReportBillItemDto {
  @ApiProperty({ description: '产品侧账单号', example: 'storage-20261008-000123' })
  @IsString()
  @MaxLength(64)
  bill_no!: string;

  @ApiProperty({ description: '账单金额，单位：分', example: 3000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount_cents!: number;

  @ApiPropertyOptional({ description: '账单类型：1 充值 2 扣费 3 退款', enum: [1, 2, 3], default: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3])
  type?: number;

  @ApiPropertyOptional({ description: '门户用户 UUID（可选）' })
  @IsOptional()
  @IsString()
  @MaxLength(36)
  portal_user_id?: string;

  @ApiPropertyOptional({ description: '退款时指向的原单号' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  related_bill_no?: string;
}

export class ReportBillsDto {
  @ApiProperty({ description: '业务日（UTC），格式 YYYY-MM-DD', example: '2026-10-08' })
  @IsString()
  @MaxLength(10)
  biz_date!: string;

  @ApiProperty({ description: '产品代码', example: 'storage' })
  @IsString()
  @MaxLength(32)
  product_code!: string;

  @ApiProperty({ description: '账单明细', type: [ReportBillItemDto] })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => ReportBillItemDto)
  bills!: ReportBillItemDto[];
}
