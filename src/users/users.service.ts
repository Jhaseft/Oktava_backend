import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Role, type User } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';

type ClientSegment = 'vip' | 'frequent' | 'new';

function deriveSegment(totalOrders: number): ClientSegment {
  if (totalOrders >= 50) return 'vip';
  if (totalOrders >= 20) return 'frequent';
  return 'new';
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Auth-facing methods (used by AuthService — do not remove) ─────────────

  async create(createUserDto: CreateUserDto): Promise<User> {
    try {
      return await this.prisma.user.create({ data: createUserDto });
    } catch (error: any) {
      if (error.code === 'P2002' && error.meta?.target?.includes('email')) {
        throw new Error('User with this email already exists');
      }
      throw new InternalServerErrorException('Error al crear el usuario.');
    }
  }

  async findOneByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
  }

  async findOrCreateGoogleUser(googleUser: {
    email: string;
    firstName: string;
    lastName: string;
  }): Promise<User> {
    const existing = await this.findOneByEmail(googleUser.email);
    if (existing) return existing;

    return this.prisma.user.create({
      data: {
        email: googleUser.email,
        firstName: googleUser.firstName,
        lastName: googleUser.lastName,
      },
    });
  }

  async updateLastLogin(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLogin: new Date() },
    });
  }

  // ─── Admin-facing methods ──────────────────────────────────────────────────

  async findAllClients(query: QueryUsersDto) {
    const search = query.search?.trim();

    const users = await this.prisma.user.findMany({
      where: {
        role: Role.CUSTOMER,
        isActive: true,
        ...(search && {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
          ],
        }),
      },
      include: {
        addresses: {
          take: 1,
          orderBy: { id: 'asc' },
          select: { direction: true, label: true },
        },
        orders: {
          select: { total: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return users.map((user) => this.mapToClientResponse(user));
  }

  async findOneClient(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        addresses: {
          orderBy: { id: 'asc' },
          select: { direction: true, label: true },
        },
        orders: {
          select: { total: true, createdAt: true, status: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!user) throw new NotFoundException(`User ${id} not found`);

    const totalOrders = await this.prisma.order.count({ where: { userId: id } });
    const totalSpentAgg = await this.prisma.order.aggregate({
      where: { userId: id },
      _sum: { total: true },
    });

    return {
      ...this.mapToClientResponse({
        ...user,
        orders: user.orders.map((o) => ({ total: o.total })),
      }),
      totalOrders,
      totalSpent: Number(totalSpentAgg._sum.total ?? 0),
      segment: deriveSegment(totalOrders),
      recentOrders: user.orders,
    };
  }

  async updateClient(id: string, dto: AdminUpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    return {
      id: updated.id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      email: updated.email,
      phone: updated.phone ?? null,
      isActive: updated.isActive,
    };
  }

  async deactivateClient(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);

    await this.prisma.user.update({
      where: { id },
      data: { isActive: false },
    });

    return { message: `User ${id} deactivated` };
  }

  // ─── Private mapper ────────────────────────────────────────────────────────

  private mapToClientResponse(user: any) {
    const orders: { total: any }[] = user.orders ?? [];
    const totalOrders = orders.length;
    const totalSpent = orders.reduce((sum, o) => sum + Number(o.total), 0);
    const firstAddress = user.addresses?.[0];

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone ?? null,
      address: firstAddress?.direction ?? null,
      totalOrders,
      totalSpent: Math.round(totalSpent * 100) / 100,
      segment: deriveSegment(totalOrders),
      joinedAt: user.createdAt instanceof Date
        ? user.createdAt.toISOString()
        : user.createdAt,
      isActive: user.isActive,
    };
  }
}
