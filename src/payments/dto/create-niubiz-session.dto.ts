import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderType } from '@prisma/client';

export class NiubizSessionItemDto {
  @IsUUID()
  productId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreateNiubizSessionDto {
  @IsEnum(OrderType)
  orderType: OrderType;

  @IsUUID()
  @IsOptional()
  addressId?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NiubizSessionItemDto)
  items: NiubizSessionItemDto[];
}
