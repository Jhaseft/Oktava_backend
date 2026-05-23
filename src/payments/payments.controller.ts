import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { CreateNiubizSessionDto } from './dto/create-niubiz-session.dto';
import { AuthorizeNiubizPaymentDto } from './dto/authorize-niubiz-payment.dto';

interface JwtUser {
  userId: string;
  email: string;
}

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // ─── Niubiz: Sesión ───────────────────────────────────────────────────────

  /**
   * POST /payments/niubiz/session
   *
   * Crea la orden en PENDING_PAYMENT y devuelve la sessionKey para el widget JS.
   * El frontend NO envía `amount`; el monto se calcula desde la BD.
   *
   * Body: { orderType, addressId?, items: [{productId, quantity}], notes? }
   * Response: { orderId, orderNumber, purchaseNumber, amount, currency, merchantId, sessionKey, channel }
   */
  @Post('niubiz/session')
  @HttpCode(HttpStatus.OK)
  createNiubizSession(
    @Body() dto: CreateNiubizSessionDto,
    @CurrentUser() user: JwtUser,
    @Ip() ip: string,
  ) {
    return this.paymentsService.createNiubizSession(dto, user, ip);
  }

  // ─── Niubiz: Autorización ─────────────────────────────────────────────────

  /**
   * POST /payments/niubiz/authorize
   *
   * Autoriza el cargo con el transactionToken del widget JS.
   * Si aprueba: Payment→paid, Order→PENDING.
   * Si rechaza: Payment→failed, Order→PAYMENT_FAILED.
   *
   * Body: { orderId, transactionToken }
   * Response: { success, orderId, orderNumber, paymentStatus, orderStatus }
   */
  @Post('niubiz/authorize')
  @HttpCode(HttpStatus.OK)
  authorizeNiubizPayment(
    @Body() dto: AuthorizeNiubizPaymentDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.paymentsService.authorizeNiubizPayment(dto, user);
  }

  // ─── Estado de pago ───────────────────────────────────────────────────────

  /**
   * GET /payments/orders/:orderId/payment-status
   *
   * Consulta el estado del pago vinculado a una orden.
   * Response: { orderId, orderNumber, paymentStatus, orderStatus, paidAt }
   */
  @Get('orders/:orderId/payment-status')
  getPaymentStatus(
    @Param('orderId') orderId: string,
    @CurrentUser() user: JwtUser,
  ) {
    return this.paymentsService.getPaymentStatus(orderId, user);
  }

  // ─── Diagnóstico (solo ADMIN) ─────────────────────────────────────────────

  /**
   * GET /payments/niubiz/health
   *
   * Verifica credenciales y URLs de Niubiz sin generar cargos.
   */
  @Get('niubiz/health')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  niubizHealth() {
    return this.paymentsService.checkNiubizHealth();
  }
}
