import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** 契约 §1.2 登录入参 */
export class LoginDto {
  @ApiProperty({ description: '**用户名或手机号**（同一个字段，后端自动识别）', example: 'luobo' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string;

  @ApiProperty({ description: '密码', example: 'Ab12345678' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  password!: string;
}
