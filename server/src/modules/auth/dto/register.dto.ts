import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** 契约 §1.1 入参：username 4-32 位 ^[a-zA-Z0-9_]+$；password 8-64 位且至少含字母和数字 */
export class RegisterDto {
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'username 只能包含字母、数字、下划线' })
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: 'password 至少包含字母和数字' })
  password!: string;

  @IsOptional()
  @IsString()
  @Matches(/^1[3-9]\d{9}$/, { message: 'phone 需为大陆 11 位手机号' })
  phone?: string;
}
