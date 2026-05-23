import { IsString, IsUUID } from 'class-validator';

export class AuthorizeNiubizPaymentDto {
  /** ID de la orden creada por POST /payments/niubiz/session. */
  @IsUUID()
  orderId: string;

  /** Token generado por el widget JS de Niubiz en el frontend. */
  @IsString()
  transactionToken: string;
}
