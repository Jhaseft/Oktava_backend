import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsString()
  @IsNotEmpty()
  categoryId: string;

  /**
   * Precio base del producto. Se persiste en la variante "Base" de ProductVariant.
   * Decisión de diseño v1: el admin opera con un precio único por producto.
   * Las variantes adicionales (Personal, Familiar, etc.) quedan para la app de cliente.
   */
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price: number;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}
