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
  const adjusted = km * 1.25;
  if (adjusted <= 2) return 5;
  if (adjusted <= 5) return 10;
  if (adjusted <= 8) return 15;
  return 20;
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
    address: o.address
      ? {
          ...o.address,
          latitude: Number(o.address.latitude),
          longitude: Number(o.address.longitude),
        }
      : null,
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
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    dto: CreateOrderDto,
    initialStatus: OrderStatus = OrderStatus.PENDING,
  ) {
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
    }

    // Resolve each product and its price
    const resolvedItems = await Promise.all(
      dto.items.map(async ({ productId, quantity, selectedOptions }) => {
        const product = await this.prisma.product.findFirst({
          where: { id: productId, isAvailable: true },
        });
        if (!product) {
          throw new NotFoundException(`Producto ${productId} no encontrado o no disponible.`);
        }
        return { product, quantity, selectedOptions: selectedOptions ?? [] };
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
