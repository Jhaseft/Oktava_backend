import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

function generateOrderNumber(): string {
  const n = Math.floor(Math.random() * 99999)
    .toString()
    .padStart(5, '0');
  return `OKT-${n}`;
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
    })),
    address: o.address
      ? {
          ...o.address,
          latitude: Number(o.address.latitude),
          longitude: Number(o.address.longitude),
        }
      : null,
  };
}

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateOrderDto) {
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

    // Resolve base variant for each product
    const resolvedItems = await Promise.all(
      dto.items.map(async ({ productId, quantity }) => {
        const variant = await this.prisma.productVariant.findFirst({
          where: { productId, isAvailable: true },
          orderBy: { id: 'asc' },
          include: { product: true },
        });
        if (!variant) {
          throw new NotFoundException(`Producto ${productId} no encontrado o sin variante disponible.`);
        }
        return { variant, quantity };
      }),
    );

    const subtotal = resolvedItems.reduce(
      (acc, { variant, quantity }) => acc + Number(variant.price) * quantity,
      0,
    );
    const total = subtotal + deliveryFee;

    let orderNumber: string;
    let attempts = 0;
    do {
      orderNumber = generateOrderNumber();
      attempts++;
      if (attempts > 20) throw new Error('No se pudo generar un número de orden único.');
    } while (await this.prisma.order.findUnique({ where: { orderNumber } }));

    const order = await this.prisma.order.create({
      data: {
        orderNumber,
        userId,
        addressId: dto.addressId ?? null,
        orderType: dto.orderType,
        subtotal,
        deliveryFee,
        total,
        notes: dto.notes ?? null,
        items: {
          create: resolvedItems.map(({ variant, quantity }) => ({
            variantId: variant.id,
            productName: variant.product.name,
            variantName: variant.name,
            quantity,
            unitPrice: Number(variant.price),
            subtotal: Number(variant.price) * quantity,
          })),
        },
      },
      include: {
        items: true,
        address: true,
      },
    });

    return mapOrder(order);
  }

  async findMine(userId: string) {
    const orders = await this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { items: true, address: true },
    });
    return orders.map(mapOrder);
  }

  async findAll(status?: OrderStatus) {
    const orders = await this.prisma.order.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        items: true,
        address: true,
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        },
      },
    });
    return orders.map(mapOrder);
  }

  async updateStatus(id: string, status: OrderStatus) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Pedido no encontrado.');
    const updated = await this.prisma.order.update({
      where: { id },
      data: { status },
      include: {
        items: true,
        address: true,
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
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
      include: { items: true, address: true },
    });
    return mapOrder(updated);
  }
}
