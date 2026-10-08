import { IsString, MaxLength, MinLength } from 'class-validator';

/** 契约 §1.2 入参：username 支持用户名或手机号 */
export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  password!: string;
}
