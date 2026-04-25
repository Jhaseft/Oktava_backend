import { IsString, MinLength } from 'class-validator';

export class UpdateProfileDto {
  @IsString() @MinLength(6) phone: string;
}
