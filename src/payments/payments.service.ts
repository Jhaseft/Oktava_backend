import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { OrdersService } from '../orders/orders.service';
import { NiubizService } from './niubiz.service';
import { CreateNiubizSessionDto } from './dto/create-niubiz-session.dto';
import { AuthorizeNiubizPaymentDto } from './dto/authorize-niubiz-payment.dto';

interface JwtUser {
  userId: string;
  email: string;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly niubiz: NiubizService,
    private readonly config: ConfigService,
  ) {}

  // ─── Niubiz: Sesión ───────────────────────────────────────────────────────

  /**
   * Crea la orden en PENDING_PAYMENT, un Payment pending, y devuelve la
   * sessionKey de Niubiz para inicializar el widget JS en el frontend.
   *
   * El frontend NO debe enviar `amount`; el monto se calcula desde la BD.
   * La orden se crea aquí y no después de autorizar el pago.
   */
  async createNiubizSession(
    dto: CreateNiubizSessionDto,
    user: JwtUser,
    clientIp: string,
  ) {
    // 1. Crear la orden con status PENDING_PAYMENT reutilizando la lógica de
    //    OrdersService (validación de usuario, teléfono, dirección, productos).
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

    // 2. Generar purchaseNumber (máx. 8 dígitos numéricos requerido por Niubiz).
    const purchaseNumber = Date.now().toString().slice(-8);
    const currency = this.config.get<string>('NIUBIZ_CURRENCY') ?? 'PEN';
    const channel = this.config.get<string>('NIUBIZ_CHANNEL') ?? 'web';

    // 3. Crear registro Payment en estado "pending".
    const payment = await this.prisma.payment.create({
      data: {
        orderId: order.id,
        userId: user.userId,
        provider: 'niubiz',
        status: 'pending',
        amount: order.total,
        currency,
        gatewayPurchaseNumber: purchaseNumber,
      },
    });

    // 4. Crear sesión en la API de Niubiz.
    //    Si falla, marcamos el Payment como failed y relanzamos el error.
    let sessionKey: string;
    try {
      const session = await this.niubiz.createSession({
        amount: order.total,
        purchaseNumber,
        clientIp,
        userEmail: user.email,
      });
      sessionKey = session.sessionKey;
    } catch (e) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'failed', failedAt: new Date() },
      });
      throw new InternalServerErrorException(
        'No se pudo crear la sesión de pago con Niubiz. Intenta nuevamente.',
      );
    }

    // 5. Guardar la sessionKey en el registro Payment.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { gatewaySessionKey: sessionKey },
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      purchaseNumber,
      amount: order.total,
      currency,
      merchantId: this.config.get<string>('NIUBIZ_MERCHANT_ID'),
      sessionKey,
      channel,
    };
  }

  // ─── Niubiz: Autorización ─────────────────────────────────────────────────

  /**
   * Autoriza el cargo con el transactionToken generado por el widget JS.
   * Si Niubiz aprueba (ACTION_CODE "000"): Payment→paid, Order→PENDING.
   * Si Niubiz rechaza: Payment→failed, Order→PAYMENT_FAILED.
   * Idempotente: rechaza la solicitud si el Payment ya no está en "pending".
   */
  async authorizeNiubizPayment(dto: AuthorizeNiubizPaymentDto, user: JwtUser) {
    // 1. Buscar el Payment por orderId e incluir la Order.
    const payment = await this.prisma.payment.findUnique({
      where: { orderId: dto.orderId },
      include: { order: true },
    });

    if (!payment) {
      throw new NotFoundException('Pago no encontrado para esta orden.');
    }

    // 2. Validar propiedad.
    if (payment.userId !== user.userId) {
      throw new ForbiddenException('No tienes permiso para autorizar este pago.');
    }

    // 3. Idempotencia: evitar doble autorización.
    if (payment.status !== 'pending') {
      throw new BadRequestException(
        `Este pago ya fue procesado (estado actual: ${payment.status}).`,
      );
    }

    // 4. Autorizar en la API de Niubiz.
    let rawResponse: Record<string, any>;
    try {
      rawResponse = (await this.niubiz.authorize({
        transactionToken: dto.transactionToken,
        purchaseNumber: payment.gatewayPurchaseNumber!,
        amount: Number(payment.amount),
        currency: payment.currency,
      })) as Record<string, any>;
    } catch {
      // Error de red o HTTP con Niubiz → marcar como fallido.
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'failed', failedAt: new Date() },
        }),
        this.prisma.order.update({
          where: { id: payment.orderId },
          data: { status: OrderStatus.PAYMENT_FAILED },
        }),
      ]);
      throw new InternalServerErrorException(
        'Error de comunicación con Niubiz. El pago no fue procesado.',
      );
    }

    // 5. Evaluar el código de respuesta de Niubiz.
    const dataMap = (rawResponse.data_map ?? {}) as Record<string, string>;
    const actionCode: string = dataMap.ACTION_CODE ?? rawResponse.actionCode ?? '';
    const isApproved = actionCode === '000';

    if (isApproved) {
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'paid',
            paidAt: new Date(),
            gatewayTransactionId: dataMap.TRANSACTION_ID ?? null,
            gatewayAuthCode: dataMap.AUTHORIZATION_CODE ?? null,
            gatewayResponseCode: actionCode,
            gatewayResponseJson: rawResponse,
          },
        }),
        this.prisma.order.update({
          where: { id: payment.orderId },
          data: { status: OrderStatus.PENDING },
        }),
      ]);

      return {
        success: true,
        orderId: payment.orderId,
        orderNumber: payment.order.orderNumber,
        paymentStatus: 'paid',
        orderStatus: OrderStatus.PENDING,
      };
    }

    // 6. Pago rechazado por Niubiz.
    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'failed',
          failedAt: new Date(),
          gatewayResponseCode: actionCode,
          gatewayResponseJson: rawResponse,
        },
      }),
      this.prisma.order.update({
        where: { id: payment.orderId },
        data: { status: OrderStatus.PAYMENT_FAILED },
      }),
    ]);

    return {
      success: false,
      orderId: payment.orderId,
      orderNumber: payment.order.orderNumber,
      paymentStatus: 'failed',
      orderStatus: OrderStatus.PAYMENT_FAILED,
    };
  }

  // ─── Estado de pago ───────────────────────────────────────────────────────

  async getPaymentStatus(orderId: string, user: JwtUser) {
    const payment = await this.prisma.payment.findUnique({
      where: { orderId },
      include: { order: { select: { orderNumber: true, status: true, userId: true } } },
    });

    if (!payment || payment.order.userId !== user.userId) {
      throw new NotFoundException('Pago no encontrado.');
    }

    return {
      orderId,
      orderNumber: payment.order.orderNumber,
      paymentStatus: payment.status,
      orderStatus: payment.order.status,
      paidAt: payment.paidAt ?? null,
    };
  }

  // ─── Diagnóstico ──────────────────────────────────────────────────────────

  async checkNiubizHealth() {
    await this.niubiz.getSecurityToken();
    return {
      ok: true,
      env: this.config.get<string>('NIUBIZ_ENV') ?? 'unknown',
      merchantId: this.config.get<string>('NIUBIZ_MERCHANT_ID'),
    };
  }
}
