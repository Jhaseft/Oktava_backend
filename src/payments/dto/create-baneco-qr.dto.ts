import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderType } from '@prisma/client';
import { OrderItemDto } from '../../orders/dto/create-order.dto';

/**
 * Payload para generar un QR Baneco. Es idéntico a crear un pedido: el backend
 * calcula el monto desde la BD (el cliente NUNCA envía el importe) y crea la
 * orden en PENDING_PAYMENT antes de pedir el QR al banco.
 */
export class CreateBanecoQrDto {
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
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}
