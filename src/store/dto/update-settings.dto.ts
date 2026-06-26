import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSettingsDto {
  @IsBoolean()
  ordersPaused: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  pauseMessage?: string;
}
