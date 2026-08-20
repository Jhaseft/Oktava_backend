import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStatus, OrderType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { StoreService } from '../store/store.service';

/**
 * Mensaje de notificación por estado de pedido (solo los relevantes para el
 * cliente). Si un estado no está aquí, no se envía push.
 */
const STATUS_PUSH: Partial<Record<OrderStatus, { title: string; body: string }>> = {
  [OrderStatus.ACCEPTED]: {
    title: 'Pedido aceptado 🎉',
    body: 'Tu pedido fue aceptado y pronto empezaremos a prepararlo.',
  },
  [OrderStatus.PREPARING]: {
    title: 'Preparando tu pedido 👨‍🍳',
    body: 'Estamos cocinando tu pedido.',
  },
  [OrderStatus.ON_THE_WAY]: {
    title: 'Tu pedido va en camino 🛵',
    body: 'El repartidor ya salió con tu pedido.',
  },
  [OrderStatus.PICKED_UP]: {
    title: 'Pedido listo para recoger 🛍️',
    body: 'Tu pedido está listo para que lo recojas en el local.',
  },
  [OrderStatus.COMPLETED]: {
    title: 'Pedido completado 🎉',
    body: '¡Gracias por tu compra! Esperamos que lo disfrutes.',
  },
  [OrderStatus.CANCELLED]: {
    title: 'Pedido cancelado',
    body: 'Tu pedido fue cancelado. Si tienes dudas, contáctanos.',
  },
  [OrderStatus.PAYMENT_FAILED]: {
    title: 'Problema con el pago',
    body: 'No pudimos procesar el pago de tu pedido.',
  },
};

const STORE_LAT = -17.392267;
const STORE_LNG = -66.069302;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const MAX_DELIVERY_KM = 14;

function calcDeliveryFee(km: number): number {
  // Base 10 Bs hasta 2 km; +1 Bs por cada 0.5 km adicionales.
  // Ej: 2 km → 10, 2.5 km → 11, 3 km → 12, y así.
  const extra = Math.max(0, km - 2);
  return Math.round(10 + extra * 2);
}

// Bolivia es UTC-4. Calcula el rango UTC del día actual según zona horaria boliviana.
function getBoliviaDay(): { start: Date; end: Date } {
  const BOL_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC-4
  const nowBOL = Date.now() - BOL_OFFSET_MS;
  const midnightBOL = new Date(nowBOL);
  midnightBOL.setUTCHours(0, 0, 0, 0);
  const start = new Date(midnightBOL.getTime() + BOL_OFFSET_MS);
  const end   = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}

/**
 * Devuelve la dirección de entrega del pedido. Prefiere el snapshot congelado
 * en la propia orden; si no existe (pedidos anteriores a esta función) cae a la
 * relación viva con la tabla addresses.
 */
function buildOrderAddress(o: any) {
  if (o.deliveryDirection != null) {
    return {
      id: o.addressId,
      label: o.deliveryLabel,
      direction: o.deliveryDirection,
      departament: o.deliveryDepartament,
      reference: o.deliveryReference,
      contact: o.deliveryContact,
      latitude: o.deliveryLatitude != null ? Number(o.deliveryLatitude) : null,
      longitude: o.deliveryLongitude != null ? Number(o.deliveryLongitude) : null,
    };
  }
  if (o.address) {
    return {
      ...o.address,
      latitude: Number(o.address.latitude),
      longitude: Number(o.address.longitude),
    };
  }
  return null;
}

function mapOrder(o: any) {
  return {
    ...o,
    subtotal: Number(o.subtotal),
    deliveryFee: Number(o.deliveryFee),
    total: Number(o.total),
    items: o.items?.map((i: any) => ({
      ...i,
      unitPrice: Number(i.unitPrice),
      subtotal: Number(i.subtotal),
      selectedOptions: (i.selectedOptions ?? []).map((opt: any) => ({
        id: opt.id,
        optionId: opt.optionId,
        optionName: opt.optionName,
        extraPrice: Number(opt.extraPrice),
      })),
    })),
    address: buildOrderAddress(o),
    attendedBy: o.attendedBy
      ? {
          id: o.attendedBy.id,
          firstName: o.attendedBy.firstName,
          lastName: o.attendedBy.lastName,
        }
      : null,
  };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly store: StoreService,
  ) {}

  async create(
    userId: string,
    dto: CreateOrderDto,
    initialStatus: OrderStatus = OrderStatus.PENDING,
  ) {
    // El local debe estar abierto (horario configurado o no estar en pausa manual).
    await this.store.assertOpen();

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');
    if (!user.phoneVerified) {
      throw new HttpException(
        { code: 'PHONE_NOT_VERIFIED', message: 'Debes verificar tu número de teléfono antes de realizar un pedido.' },
        HttpStatus.FORBIDDEN,
      );
    }

    if (dto.items.length === 0) {
      throw new BadRequestException('El pedido debe tener al menos un producto.');
    }

    let deliveryFee = 0;
    // Snapshot de la dirección, congelado al crear el pedido (solo DELIVERY).
    let deliverySnapshot: {
      deliveryLabel: string;
      deliveryDirection: string;
      deliveryDepartament: string;
      deliveryReference: string | null;
      deliveryContact: string | null;
      deliveryLatitude: Prisma.Decimal;
      deliveryLongitude: Prisma.Decimal;
    } | null = null;

    if (dto.orderType === OrderType.DELIVERY) {
      if (!dto.addressId) {
        throw new BadRequestException('Se requiere una dirección para pedidos de delivery.');
      }
      const address = await this.prisma.address.findUnique({
        where: { id: dto.addressId },
      });
      if (!address || address.userId !== userId) {
        throw new NotFoundException('Dirección no encontrada.');
      }
      const km = haversineKm(
        STORE_LAT,
        STORE_LNG,
        Number(address.latitude),
        Number(address.longitude),
      );
      if (km > MAX_DELIVERY_KM) {
        throw new BadRequestException(
          `La dirección está fuera del rango de entrega (máximo ${MAX_DELIVERY_KM} km).`,
        );
      }
      deliveryFee = calcDeliveryFee(km);
      deliverySnapshot = {
        deliveryLabel: address.label,
        deliveryDirection: address.direction,
        deliveryDepartament: address.departament,
        deliveryReference: address.reference,
        deliveryContact: address.contact,
        deliveryLatitude: address.latitude,
        deliveryLongitude: address.longitude,
      };
    }

    // Resuelve cada producto y valida sus opciones contra la BD. NUNCA se confía
    // en el precio ni el nombre que manda el cliente: `extraPrice` y `optionName`
    // se toman siempre de la tabla Option, y se verifica que cada opción
    // pertenezca al producto y esté disponible.
    const resolvedItems = await Promise.all(
      dto.items.map(async ({ productId, quantity, selectedOptions }) => {
        const product = await this.prisma.product.findFirst({
          where: { id: productId, isAvailable: true },
          include: { optionGroups: { include: { options: true } } },
        });
        if (!product) {
          throw new NotFoundException(`Producto ${productId} no encontrado o no disponible.`);
        }

        // Opciones válidas y disponibles de este producto, indexadas por id.
        const validOptions = new Map<string, { name: string; extraPrice: number }>();
        for (const group of product.optionGroups) {
          for (const opt of group.options) {
            if (opt.isAvailable) {
              validOptions.set(opt.id, { name: opt.name, extraPrice: Number(opt.extraPrice) });
            }
          }
        }

        const resolvedOptions = (selectedOptions ?? []).map(({ optionId }) => {
          const dbOption = validOptions.get(optionId);
          if (!dbOption) {
            throw new BadRequestException(
              `Una de las opciones seleccionadas no es válida o no está disponible para "${product.name}".`,
            );
          }
          // Precio y nombre tomados de la BD, no del cliente.
          return { optionId, optionName: dbOption.name, extraPrice: dbOption.extraPrice };
        });

        return { product, quantity, selectedOptions: resolvedOptions };
      }),
    );

    const subtotal = resolvedItems.reduce(
      (acc, { product, quantity, selectedOptions }) => {
        const extrasTotal = selectedOptions.reduce((s, o) => s + o.extraPrice, 0);
        return acc + (Number(product.price) + extrasTotal) * quantity;
      },
      0,
    );
    const total = subtotal + deliveryFee;

    // Genera número secuencial diario dentro de una transacción serializable
    // para evitar colisiones en creaciones concurrentes.
    let order: Awaited<ReturnType<typeof this.prisma.order.create>>;
    let txAttempts = 0;
    while (true) {
      try {
        order = await this.prisma.$transaction(
          async (tx) => {
            const { start, end } = getBoliviaDay();

            // Lee todos los números de hoy con formato OKT-XXXX (4 dígitos)
            const todayOrders = await tx.order.findMany({
              where: { createdAt: { gte: start, lt: end } },
              select: { orderNumber: true },
            });

            let maxSeq = 0;
            for (const o of todayOrders) {
              const m = o.orderNumber.match(/^OKT-(\d{4})$/);
              if (m) {
                const n = parseInt(m[1], 10);
                if (n > maxSeq) maxSeq = n;
              }
            }

            const seq = maxSeq + 1;
            if (seq > 9999) {
              throw new BadRequestException('Se alcanzó el límite diario de pedidos (9999).');
            }

            const orderNumber = `OKT-${seq.toString().padStart(4, '0')}`;

            return tx.order.create({
              data: {
                orderNumber,
                userId,
                addressId: dto.addressId ?? null,
                orderType: dto.orderType,
                status: initialStatus,
                subtotal,
                deliveryFee,
                total,
                notes: dto.notes ?? null,
                ...(deliverySnapshot ?? {}),
                items: {
                  create: resolvedItems.map(({ product, quantity, selectedOptions }) => {
                    const extrasTotal = selectedOptions.reduce((s, o) => s + o.extraPrice, 0);
                    return {
                      productId: product.id,
                      productName: product.name,
                      quantity,
                      unitPrice: Number(product.price),
                      subtotal: (Number(product.price) + extrasTotal) * quantity,
                      selectedOptions: selectedOptions.length > 0
                        ? {
                            create: selectedOptions.map((opt) => ({
                              optionId: opt.optionId,
                              optionName: opt.optionName,
                              extraPrice: opt.extraPrice,
                            })),
                          }
                        : undefined,
                    };
                  }),
                },
              },
              include: {
                items: { include: { selectedOptions: true } },
                address: true,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (e: any) {
        // P2034 = serialization failure — reintentar hasta 3 veces
        if (e?.code === 'P2034' && txAttempts < 3) {
          txAttempts++;
          continue;
        }
        throw e;
      }
    }

    return mapOrder(order);
  }

  async findMine(userId: string) {
    const orders = await this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { items: { include: { selectedOptions: true } }, address: true },
    });
    return orders.map(mapOrder);
  }

  async findAll(status?: OrderStatus) {
    const orders = await this.prisma.order.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        items: { include: { selectedOptions: true } },
        address: true,
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        },
        attendedBy: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
    return orders.map(mapOrder);
  }

  async updateStatus(id: string, status: OrderStatus, adminId: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Pedido no encontrado.');

    const attendedData = order.attendedById
      ? {}
      : { attendedById: adminId, attendedAt: new Date() };

    const updated = await this.prisma.order.update({
      where: { id },
      data: { status, ...attendedData },
      include: {
        items: { include: { selectedOptions: true } },
        address: true,
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        },
        attendedBy: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    // Notifica al cliente solo si el estado realmente cambió y es relevante.
    // Fire-and-forget: un fallo de push no debe romper el cambio de estado.
    if (order.status !== status) {
      const push = STATUS_PUSH[status];
      if (push) {
        void this.notifications.sendToUser(updated.userId, {
          title: push.title,
          body: `${push.body} (Pedido ${updated.orderNumber})`,
          data: { type: 'order', orderId: updated.id, status },
        });
      }
    }

    return mapOrder(updated);
  }

  async confirmReceived(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (order?.userId !== userId) throw new NotFoundException('Pedido no encontrado.');
    if (order.status !== OrderStatus.ON_THE_WAY && order.status !== OrderStatus.PICKED_UP) {
      throw new BadRequestException('El pedido aún no está listo para confirmar recepción.');
    }
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.COMPLETED },
      include: { items: { include: { selectedOptions: true } }, address: true },
    });
    return mapOrder(updated);
  }
}
