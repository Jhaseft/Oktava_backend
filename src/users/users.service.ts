import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Role, type User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma.service';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';

function normalizePhone(raw: string): string {
  const stripped = raw.replace(/[\s\-().]/g, '');
  return stripped.startsWith('+') ? stripped : `+${stripped}`;
}

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

  async findOneById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findOneByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  async setPhoneVerified(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { phoneVerified: true } });
  }

  async findOrCreateGoogleUser(googleUser: {
    email: string;
    firstName: string;
    lastName: string;
    googleId?: string;
  }): Promise<User> {
    // 1. Buscar por googleId si se proporcionó
    if (googleUser.googleId) {
      const byGoogleId = await this.prisma.user.findUnique({
        where: { googleId: googleUser.googleId },
      });
      if (byGoogleId) return byGoogleId;
    }

    // 2. Buscar por email
    const byEmail = await this.findOneByEmail(googleUser.email);

    if (byEmail) {
      // Si ya existe por email pero no tiene googleId, vincularlo
      if (googleUser.googleId && !byEmail.googleId) {
        return this.prisma.user.update({
          where: { id: byEmail.id },
          data: { googleId: googleUser.googleId, provider: 'google' },
        });
      }
      return byEmail;
    }

    // 3. Crear usuario nuevo con campos de Google
    return this.prisma.user.create({
      data: {
        email: googleUser.email,
        firstName: googleUser.firstName,
        lastName: googleUser.lastName,
        googleId: googleUser.googleId,
        provider: googleUser.googleId ? 'google' : 'email',
      },
    });
  }

  async findOrCreateAppleUser(appleUser: {
    appleId: string;
    email: string;
    firstName: string;
    lastName: string;
  }): Promise<User> {
    // 1. Buscar por appleId (identificador estable de Apple)
    const byAppleId = await this.prisma.user.findUnique({
      where: { appleId: appleUser.appleId },
    });
    if (byAppleId) return byAppleId;

    // 2. Buscar por email. Apple solo envía email/nombre en el PRIMER login,
    // por eso el appleId es el vínculo confiable en logins posteriores.
    const byEmail = await this.findOneByEmail(appleUser.email);

    if (byEmail) {
      // Si ya existe por email pero no tiene appleId, vincularlo
      if (!byEmail.appleId) {
        return this.prisma.user.update({
          where: { id: byEmail.id },
          data: { appleId: appleUser.appleId, provider: byEmail.provider ?? 'apple' },
        });
      }
      return byEmail;
    }

    // 3. Crear usuario nuevo con campos de Apple
    return this.prisma.user.create({
      data: {
        email: appleUser.email,
        firstName: appleUser.firstName,
        lastName: appleUser.lastName,
        appleId: appleUser.appleId,
        provider: 'apple',
      },
    });
  }

  async updateLastLogin(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLogin: new Date() },
    });
  }

  async setPasswordResetToken(userId: string, hashedToken: string, expiry: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordResetToken: hashedToken, passwordResetExpiry: expiry },
    });
  }

  async findByPasswordResetToken(hashedToken: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { passwordResetToken: hashedToken } });
  }

  async updatePasswordAndClearResetToken(userId: string, hashedPassword: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword, passwordResetToken: null, passwordResetExpiry: null },
    });
  }

  async updatePhone(userId: string, phone: string): Promise<void> {
    const current = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phone,
        ...(current?.phone !== phone && { phoneVerified: false }),
      },
    });
  }

  // ─── Admin-facing methods ──────────────────────────────────────────────────

  async findAllAdmins() {
    const users = await this.prisma.user.findMany({
      where: { role: Role.ADMIN },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        isActive: true,
        createdAt: true,
      },
    });
    return users;
  }

  async createAdmin(dto: CreateAdminDto) {
    const existing = await this.findOneByEmail(dto.email);
    if (existing) throw new ConflictException('Ya existe un usuario con ese correo.');

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email.toLowerCase().trim(),
        password: hashedPassword,
        role: Role.ADMIN,
        phoneVerified: true,
      },
    });

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
    };
  }


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

    const normalizedPhone = dto.phone !== undefined ? normalizePhone(dto.phone) : undefined;
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(normalizedPhone !== undefined && {
          phone: normalizedPhone,
          ...(normalizedPhone !== user.phone && { phoneVerified: false }),
        }),
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
