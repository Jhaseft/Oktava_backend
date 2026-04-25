import { IsEmail, IsString, MinLength } from 'class-validator';

export class SignUpDto {
  @IsString() firstName: string;
  @IsString() lastName: string;
  @IsEmail() email: string;
  @IsString() phone: string;
  @IsString() @MinLength(6) password: string;
  @IsString() @MinLength(6) verificationCode: string;
}
