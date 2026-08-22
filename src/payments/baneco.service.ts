import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { OrdersService } from '../orders/orders.service';
import { NotificationsService } from '../notifications/notifications.service';
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
export class BanecoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BanecoService.name);
  // Escuchadores activos, uno por qrId. Viven ~10 min y se autodestruyen apenas
  // el pago se confirma/cancela (o al vencer la ventana).
  private readonly watchers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly banecoApi: BanecoApiService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  private get pendingExpireMinutes(): number {
    const raw = this.config.get<string>('BANECO_PENDING_EXPIRE_MINUTES');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  }

  private get watchDurationMs(): number {
    const raw = this.config.get<string>('BANECO_WATCH_DURATION_MS');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 600_000; // 10 min
  }

  private get watchIntervalMs(): number {
    const raw = this.config.get<string>('BANECO_WATCH_INTERVAL_MS');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 3_000 ? parsed : 8_000; // 8s
  }

  private get qrCooldownMs(): number {
    const raw = this.config.get<string>('BANECO_QR_COOLDOWN_MS');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000; // 30s
  }

  // ─── Ciclo de vida: re-armado de escuchadores ──────────────────────────────

  /**
   * Al iniciar (o reiniciar) el server, re-arma un escuchador para cada pago
   * pendiente creado dentro de la ventana de vigilancia. Cubre el caso de un
   * reinicio en medio de los 10 min. Es una única pasada, NO un cron.
   */
  async onModuleInit() {
    if (!this.banecoApi.isConfigured()) return;
    try {
      const since = new Date(Date.now() - this.watchDurationMs);
      const pendings = await this.prisma.payment.findMany({
        where: {
          provider: PROVIDER,
          status: 'pending',
          gatewayTransactionId: { not: null },
          createdAt: { gte: since },
        },
        select: { gatewayTransactionId: true, createdAt: true },
      });
      for (const p of pendings) {
        const deadline = p.createdAt.getTime() + this.watchDurationMs;
        this.startWatcher(p.gatewayTransactionId!, deadline);
      }
      if (pendings.length > 0) {
        this.logger.log(`[WATCH] re-armados ${pendings.length} escuchadores al iniciar`);
      }
    } catch (e: any) {
      this.logger.error(`[WATCH] re-armado inicial falló: ${e?.message ?? e}`);
    }
  }

  onModuleDestroy() {
    for (const timer of this.watchers.values()) clearInterval(timer);
    this.watchers.clear();
  }

  // ─── Escuchador por-QR ─────────────────────────────────────────────────────

  /** Arranca (si no existe) un escuchador que sondea el pago hasta `deadline`. */
  private startWatcher(qrId: string, deadline = Date.now() + this.watchDurationMs) {
    if (this.watchers.has(qrId)) return;
    const timer = setInterval(() => {
      void this.watchTick(qrId, deadline);
    }, this.watchIntervalMs);
    this.watchers.set(qrId, timer);
  }

  /** Detiene y elimina el escuchador de un qrId (idempotente). */
  private stopWatcher(qrId: string) {
    const timer = this.watchers.get(qrId);
    if (timer) {
      clearInterval(timer);
      this.watchers.delete(qrId);
    }
  }

  /**
   * Un ciclo del escuchador: si el pago ya se resolvió por otra vía, se apaga;
   * si sigue pendiente, consulta al banco y confirma/cancela; al vencer la
   * ventana, cancela el pedido (silencioso, sin push) salvo que el banco reporte
   * que ya se pagó (en cuyo caso confirma).
   */
  private async watchTick(qrId: string, deadline: number) {
    try {
      const payment = await this.prisma.payment.findFirst({
        where: { provider: PROVIDER, gatewayTransactionId: qrId },
        select: { status: true },
      });
      // Ya resuelto por el frontend u otra vía → dejar de escuchar.
      if (!payment || payment.status !== 'pending') {
        this.stopWatcher(qrId);
        return;
      }

      const remote = await this.banecoApi.statusQR(qrId);
      if (remote.statusQrCode === 1) {
        await this.applyPaymentByQrId(qrId, BanecoApiService.firstPayment(remote.payment));
        this.stopWatcher(qrId);
        return;
      }
      if (remote.statusQrCode === 9) {
        await this.markFailed(qrId);
        this.stopWatcher(qrId);
        return;
      }

      // Sigue pendiente: ¿venció la ventana de 10 min?
      if (Date.now() >= deadline) {
        // Paid-safe: si justo se pagó entre el sondeo y ahora, el banco rechaza
        // la anulación con "pagado" → confirmamos en vez de cancelar.
        const res = await this.banecoApi.cancelQR(qrId).catch(() => ({ responseCode: -1, message: '' }));
        if (res.responseCode !== 0 && /pagado/i.test(res.message ?? '')) {
          await this.applyPaymentByQrId(qrId, null);
        } else {
          await this.markCancelled(qrId); // cancelación silenciosa (sin push)
          this.logger.log(`[WATCH] vencido y cancelado qrId=${qrId}`);
        }
        this.stopWatcher(qrId);
      }
    } catch {
      // Fallo puntual de red: reintenta al próximo tick. Si ya venció, se apaga.
      if (Date.now() >= deadline) this.stopWatcher(qrId);
    }
  }

  /**
   * Reconciliación BAJO DEMANDA (no hay cron): se dispara cuando el usuario abre
   * sus pedidos. Revisa solo SUS pagos pendientes contra el banco:
   *  - pagado (1)   → confirma el pedido (rescata pagos perdidos por cierre de app).
   *  - anulado (9)  → marca fallido.
   *  - pendiente(0) → si ya venció la ventana, anula en el banco y cancela.
   * Si el usuario no tiene pendientes, no llama al banco.
   */
  async reconcilePendingForUser(userId: string) {
    const pendings = await this.prisma.payment.findMany({
      where: {
        provider: PROVIDER,
        status: 'pending',
        userId,
        gatewayTransactionId: { not: null },
      },
      select: { id: true, gatewayTransactionId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    if (pendings.length === 0) return { confirmed: 0, cancelled: 0 };

    let confirmed = 0;
    let cancelled = 0;
    for (const p of pendings) {
      const qrId = p.gatewayTransactionId!;
      try {
        const remote = await this.banecoApi.statusQR(qrId);
        if (remote.statusQrCode === 1) {
          await this.applyPaymentByQrId(qrId, BanecoApiService.firstPayment(remote.payment));
          confirmed++;
          this.logger.log(`[RECONCILE] pago rescatado qrId=${qrId} userId=${userId}`);
          continue;
        }
        if (remote.statusQrCode === 9) {
          await this.markFailed(qrId);
          cancelled++;
          continue;
        }
        const ageMin = (Date.now() - p.createdAt.getTime()) / 60_000;
        if (ageMin >= this.pendingExpireMinutes) {
          await this.banecoApi.cancelQR(qrId).catch(() => undefined);
          await this.markCancelled(qrId);
          cancelled++;
          this.logger.log(`[RECONCILE] vencido y cancelado qrId=${qrId} ageMin=${Math.round(ageMin)}`);
        }
      } catch {
        // Fallo de red puntual: se reintenta la próxima vez que abra Pedidos.
      }
    }
    return { confirmed, cancelled };
  }

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

    // 0. Rate limit anti-spam: no permitir generar QRs muy seguido por usuario.
    const cooldownMs = this.qrCooldownMs;
    if (cooldownMs > 0) {
      const last = await this.prisma.payment.findFirst({
        where: { userId: user.userId, provider: PROVIDER },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (last && Date.now() - last.createdAt.getTime() < cooldownMs) {
        const wait = Math.ceil((cooldownMs - (Date.now() - last.createdAt.getTime())) / 1000);
        throw new HttpException(
          { code: 'QR_COOLDOWN', message: `Espera ${wait}s antes de generar otro QR.` },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

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

      // Arranca el escuchador: sondea el pago cada ~8s por 10 min, aunque el
      // cliente cierre la app. Se apaga apenas se confirme/cancele.
      this.startWatcher(qr.qrId);

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
      include: { order: { select: { orderNumber: true } } },
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

    // El pago quedó confirmado por esta llamada: apagamos el escuchador.
    this.stopWatcher(qrId);

    // Anulamos el QR en el banco NOSOTROS (no confiamos en que el banco aplique
    // el singleUse): así queda muerto y no se puede volver a pagar el mismo QR.
    // Si el banco ya lo bloqueó, responderá error y lo ignoramos.
    void this.banecoApi.cancelQR(qrId).catch(() => undefined);

    // Notificamos al cliente (ÚNICA notificación del flujo QR).
    void this.notifications.sendToUser(payment.userId, {
      title: 'Pago confirmado ✅',
      body: `Recibimos tu pago del pedido ${payment.order?.orderNumber ?? ''}. ¡Ya lo estamos gestionando!`,
      data: { type: 'payment_confirmed', orderId: payment.orderId },
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
    this.stopWatcher(qrId);
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
    this.stopWatcher(qrId);
    if (claimed.count === 0) return;

    await this.prisma.order.updateMany({
      where: { id: payment.orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.CANCELLED },
    });
  }
}
