import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * 修改自己的密码（`POST /api/auth/password`）。
 *
 * 必须提供旧密码：防止 access token 被盗后直接改密把账号锁死。
 */
export class ChangePasswordDto {
  @ApiProperty({ description: '当前密码', example: 'OldPass123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  old_password!: string;

  @ApiProperty({ description: '新密码：8-64 位，需同时包含字母和数字', example: 'NewPass456' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: 'new_password 至少包含字母和数字' })
  new_password!: string;
}
