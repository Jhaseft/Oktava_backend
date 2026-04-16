import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  /** If omitted, the service will slugify the name automatically. */
  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;
}
