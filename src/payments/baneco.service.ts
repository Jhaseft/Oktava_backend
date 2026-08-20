import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { OrdersService } from '../orders/orders.service';
import { BanecoApiService, PaymentQR } from './baneco-api.service';
import { CreateBanecoQrDto } from './dto/create-baneco-qr.dto';

interface JwtUser {
  userId: string;
  email: string;
}

const PROVIDER = 'baneco';

/**
 * Lógica de negocio del cobro por QR de Banco Económico.
 *
 * Reutiliza los modelos existentes Order + Payment:
 *   - Order se crea en PENDING_PAYMENT (vía OrdersService, con todas sus
 *     validaciones: teléfono verificado, tienda abierta, dirección, precios).
 *   - Payment(provider='baneco', status='pending') guarda el qrId del banco en
 *     `gatewayTransactionId` para poder localizarlo en el polling y el webhook.
 *
 * Al confirmarse el pago: Payment→paid y Order→PENDING (entra a la cola normal),
 * igual que el flujo de Niubiz.
 */
@Injectable()
export class BanecoService {
  private readonly logger = new Logger(BanecoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly banecoApi: BanecoApiService,
    private readonly config: ConfigService,
  ) {}

  private get currency(): 'BOB' | 'USD' {
    return (this.config.get<string>('BANECO_CURRENCY') as 'BOB' | 'USD') ?? 'BOB';
  }

  private get qrTtlDays(): number {
    const raw = this.config.get<string>('BANECO_QR_TTL_DAYS');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  private newReqId() {
    return Math.random().toString(36).slice(2, 9);
  }

  private buildDueDate(): string {
    const due = new Date();
    due.setDate(due.getDate() + this.qrTtlDays);
    return due.toISOString().slice(0, 10);
  }

  // ─── Crear QR para un checkout ─────────────────────────────────────────────

  /**
   * Crea la orden en PENDING_PAYMENT, un Payment 'pending' y genera el QR del
   * banco. Devuelve la imagen base64 y el qrId para que el frontend muestre y
   * haga polling. Si el banco falla, marca el Payment como failed.
   */
  async createQr(dto: CreateBanecoQrDto, user: JwtUser) {
    const traceId = this.newReqId();

    // 1. Crear la orden (valida usuario/teléfono/tienda/dirección/precios).
    const order = await this.orders.create(
      user.userId,
      {
        orderType: dto.orderType,
        addressId: dto.addressId,
        notes: dto.notes,
        items: dto.items,
      },
      OrderStatus.PENDING_PAYMENT,
    );

    const amount = Number(order.total);
    const currency = this.currency;
    const dueDate = this.buildDueDate();

    this.logger.log(
      `[QR][${traceId}] orderId=${order.id} orderNumber=${order.orderNumber} amount=${amount} currency=${currency}`,
    );

    // 2. Crear el Payment 'pending'. El qrId se guardará tras generar el QR.
    const payment = await this.prisma.payment.create({
      data: {
        orderId: order.id,
        userId: user.userId,
        provider: PROVIDER,
        status: 'pending',
        amount: order.total,
        currency,
      },
    });

    // 3. Pedir el QR al banco. transactionId = payment.id (nuestra referencia).
    try {
      const qr = await this.banecoApi.generateQR({
        transactionId: payment.id,
        amount,
        currency,
        description: `Oktava ${order.orderNumber}`,
        dueDate,
        singleUse: true,
        modifyAmount: false,
        reqId: traceId,
      });

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { gatewayTransactionId: qr.qrId },
      });

      this.logger.log(`[QR][${traceId}] success orderId=${order.id} qrId=${qr.qrId}`);

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        qrId: qr.qrId,
        qrImage: qr.qrImage,
        amount,
        currency,
        dueDate,
      };
    } catch (err: any) {
      this.logger.error(
        `[QR][${traceId}] failed orderId=${order.id} reason=${err?.response?.code ?? err?.message ?? 'unknown'}`,
      );
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'failed', failedAt: new Date() },
        }),
        this.prisma.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.PAYMENT_FAILED },
        }),
      ]);
      throw err;
    }
  }

  // ─── Consultar estado (polling del frontend) ───────────────────────────────

  /**
   * Devuelve el estado del QR. Corta en seco si el Payment ya está resuelto en
   * la BD; si sigue pendiente consulta al banco y aplica el pago si corresponde.
   */
  async getStatus(qrId: string, user: JwtUser, reqId?: string) {
    const traceId = reqId ?? this.newReqId();

    const payment = await this.prisma.payment.findFirst({
      where: { provider: PROVIDER, gatewayTransactionId: qrId },
      include: { order: { select: { id: true, userId: true } } },
    });
    if (!payment) throw new NotFoundException('QR no encontrado.');
    if (payment.userId !== user.userId) {
      throw new ForbiddenException('No tienes permiso para consultar este pago.');
    }

    if (payment.status === 'paid') {
      return { status: 'PAID' as const, orderId: payment.orderId };
    }
    if (payment.status === 'failed' || payment.status === 'cancelled') {
      return { status: 'CANCELED' as const, orderId: payment.orderId };
    }

    const remote = await this.banecoApi.statusQR(qrId, traceId);
    const paymentObj = BanecoApiService.firstPayment(remote.payment);

    if (remote.statusQrCode === 1) {
      await this.applyPaymentByQrId(qrId, paymentObj);
      return { status: 'PAID' as const, orderId: payment.orderId };
    }
    if (remote.statusQrCode === 9) {
      await this.markFailed(qrId);
      return { status: 'CANCELED' as const, orderId: payment.orderId };
    }

    return { status: 'PENDING' as const, orderId: payment.orderId };
  }

  // ─── Cancelar QR ───────────────────────────────────────────────────────────

  async cancel(qrId: string, user: JwtUser, reqId?: string) {
    const traceId = reqId ?? this.newReqId();

    const payment = await this.prisma.payment.findFirst({
      where: { provider: PROVIDER, gatewayTransactionId: qrId },
    });
    if (!payment) throw new NotFoundException('QR no encontrado.');
    if (payment.userId !== user.userId) {
      throw new ForbiddenException('No tienes permiso para anular este pago.');
    }
    if (payment.status !== 'pending') {
      return { ok: true, alreadyResolved: true };
    }

    const res = await this.banecoApi.cancelQR(qrId, traceId);

    // El banco rechaza la anulación porque el QR ya fue pagado → lo tratamos
    // como pago confirmado y acreditamos (no lo cancelamos).
    if (res.responseCode !== 0 && /pagado/i.test(res.message ?? '')) {
      await this.applyPaymentByQrId(qrId, null);
      return { ok: true, paid: true };
    }

    // En cualquier otro caso cancelamos localmente SIEMPRE: aunque el banco no
    // haya podido anular el QR, el pedido no debe quedar colgado en
    // PENDING_PAYMENT (el QR es de un solo uso y vence por dueDate).
    if (res.responseCode !== 0) {
      this.logger.warn(
        `[CANCEL][${qrId}] banco no anuló responseCode=${res.responseCode} msg="${res.message ?? ''}"; se cancela localmente igual`,
      );
    }

    await this.markCancelled(qrId);
    return { ok: true };
  }

  // ─── Webhook del banco ─────────────────────────────────────────────────────

  /** Punto de entrada del webhook público `notifyPaymentQR`. */
  async applyPayment(payment: PaymentQR) {
    if (!payment?.qrId) return;
    await this.applyPaymentByQrId(payment.qrId, payment);
  }

  // ─── Núcleo: aplicar el pago ───────────────────────────────────────────────

  /**
   * Marca el Payment como pagado y la Order como PENDING. Usa un claim atómico
   * (updateMany where status='pending') para que polling y webhook no acrediten
   * dos veces cuando llegan a la vez.
   */
  private async applyPaymentByQrId(qrId: string, bankPayment: PaymentQR | null) {
    const payment = await this.prisma.payment.findFirst({
      where: { provider: PROVIDER, gatewayTransactionId: qrId },
    });
    if (!payment) {
      this.logger.warn(`[APPLY][${qrId}] no payment found`);
      return;
    }

    // Claim atómico: solo la primera llamada concurrente obtiene count=1.
    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: 'pending' },
      data: {
        status: 'paid',
        paidAt: new Date(),
        gatewayResponseCode: '0',
        ...(bankPayment
          ? { gatewayAuthCode: bankPayment.transactionId ?? null, gatewayResponseJson: bankPayment as any }
          : {}),
      },
    });
    if (claimed.count === 0) {
      this.logger.warn(`[APPLY][${qrId}] already claimed, skipping`);
      return;
    }

    await this.prisma.order.updateMany({
      where: { id: payment.orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.PENDING },
    });

    this.logger.log(`[APPLY][${qrId}] paid orderId=${payment.orderId} amount=${payment.amount}`);
  }

  /** Marca el Payment como failed y la Order como PAYMENT_FAILED (QR anulado). */
  private async markFailed(qrId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { provider: PROVIDER, gatewayTransactionId: qrId },
    });
    if (!payment) return;

    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: 'pending' },
      data: { status: 'failed', failedAt: new Date() },
    });
    if (claimed.count === 0) return;

    await this.prisma.order.updateMany({
      where: { id: payment.orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.PAYMENT_FAILED },
    });
  }

  /** Cancelación iniciada por el usuario: Payment 'cancelled' y Order CANCELLED. */
  private async markCancelled(qrId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { provider: PROVIDER, gatewayTransactionId: qrId },
    });
    if (!payment) return;

    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: 'pending' },
      data: { status: 'cancelled', failedAt: new Date() },
    });
    if (claimed.count === 0) return;

    await this.prisma.order.updateMany({
      where: { id: payment.orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.CANCELLED },
    });
  }
}
