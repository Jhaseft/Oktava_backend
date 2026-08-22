import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BanecoService } from './baneco.service';
import { CreateBanecoQrDto } from './dto/create-baneco-qr.dto';

interface JwtUser {
  userId: string;
  email: string;
}

/**
 * Rutas del cobro por QR de Banco Económico.
 *
 * Todas requieren JWT salvo `notify`, que es el webhook público que el banco
 * invoca al confirmar un pago (la seguridad es que el qrId solo lo conoce el
 * banco). Por eso el guard se aplica por-ruta y NO a nivel de clase.
 */
@Controller('payments/baneco')
export class BanecoController {
  constructor(private readonly baneco: BanecoService) {}

  /**
   * POST /payments/baneco/qr
   * Crea la orden en PENDING_PAYMENT y genera el QR del banco.
   * Body: { orderType, addressId?, notes?, items: [...] }
   * Response: { orderId, orderNumber, qrId, qrImage, amount, currency, dueDate }
   */
  @Post('qr')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  createQr(@Body() dto: CreateBanecoQrDto, @CurrentUser() user: JwtUser) {
    return this.baneco.createQr(dto, user);
  }

  /**
   * GET /payments/baneco/qr/:qrId/status
   * Polling del estado del QR. Response: { status: 'PENDING'|'PAID'|'CANCELED', orderId }
   */
  @Get('qr/:qrId/status')
  @UseGuards(JwtAuthGuard)
  getStatus(@Param('qrId') qrId: string, @CurrentUser() user: JwtUser) {
    return this.baneco.getStatus(qrId, user);
  }

  /**
   * DELETE /payments/baneco/qr/:qrId
   * Anula un QR pendiente. Si el banco reporta que ya estaba pagado, acredita.
   */
  @Delete('qr/:qrId')
  @UseGuards(JwtAuthGuard)
  cancel(@Param('qrId') qrId: string, @CurrentUser() user: JwtUser) {
    return this.baneco.cancel(qrId, user);
  }

  /**
   * POST /payments/baneco/reconcile
   * Reconciliación bajo demanda: revisa los pagos QR pendientes del usuario
   * contra el banco (confirma los pagados, cancela los vencidos). Lo llama el
   * frontend al abrir "Mis pedidos". Response: { confirmed, cancelled }
   */
  @Post('reconcile')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  reconcile(@CurrentUser() user: JwtUser) {
    return this.baneco.reconcilePendingForUser(user.userId);
  }

  /**
   * POST /payments/baneco/notify
   * Webhook público (sin JWT) que el banco llama al confirmar un pago.
   * Debe devolver { responseCode: 0 } para que el banco lo dé por recibido.
   */
  @Post('notify')
  @HttpCode(HttpStatus.OK)
  async notify(@Body() body: { Payment?: any; payment?: any }) {
    const payment = body?.Payment ?? body?.payment;
    if (payment?.qrId) {
      await this.baneco.applyPayment(payment);
    }
    return { responseCode: 0, message: '' };
  }
}

/**
 * Alias del webhook en el path EXACTO que documenta Baneco (7.5):
 *   POST /api/qrsimple/notifyPaymentQR
 * Apunta al mismo handler, para que el banco pueda registrar la URL tal cual
 * figura en la especificación (`https://<dominio>/api/qrsimple/notifyPaymentQR`).
 */
@Controller()
export class BanecoNotifyController {
  constructor(private readonly baneco: BanecoService) {}

  @Post('api/qrsimple/notifyPaymentQR')
  @HttpCode(HttpStatus.OK)
  async notifyPaymentQR(@Body() body: { Payment?: any; payment?: any }) {
    const payment = body?.Payment ?? body?.payment;
    if (payment?.qrId) {
      await this.baneco.applyPayment(payment);
    }
    return { responseCode: 0, message: '' };
  }
}
