import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class AdminUpdateUserDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
