import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** 契约 §1.1 注册入参 */
export class RegisterDto {
  @ApiProperty({
    description: '用户名：4-32 位，仅字母/数字/下划线',
    example: 'luobo',
    minLength: 4,
    maxLength: 32,
    pattern: '^[a-zA-Z0-9_]+$',
  })
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'username 只能包含字母、数字、下划线' })
  username!: string;

  @ApiProperty({
    description: '密码：8-64 位，且至少包含字母和数字',
    example: 'Ab12345678',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: 'password 至少包含字母和数字' })
  password!: string;

  @ApiPropertyOptional({ description: '大陆手机号 11 位（可选）', example: '13800000000' })
  @IsOptional()
  @IsString()
  @Matches(/^1[3-9]\d{9}$/, { message: 'phone 需为大陆 11 位手机号' })
  phone?: string;
}
