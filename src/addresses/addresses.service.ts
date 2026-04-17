import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(userId: string) {
    return this.prisma.address.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    });
  }

  async create(userId: string, dto: CreateAddressDto) {
    return this.prisma.address.create({
      data: {
        userId,
        label: dto.label,
        direction: dto.direction,
        latitude: dto.latitude,
        longitude: dto.longitude,
        placeId: dto.placeId ?? null,
        departament: dto.departament,
        reference: dto.reference ?? null,
        contact: dto.contact ?? null,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateAddressDto) {
    await this.assertOwner(userId, id);
    return this.prisma.address.update({
      where: { id },
      data: {
        ...(dto.label !== undefined && { label: dto.label }),
        ...(dto.direction !== undefined && { direction: dto.direction }),
        ...(dto.latitude !== undefined && { latitude: dto.latitude }),
        ...(dto.longitude !== undefined && { longitude: dto.longitude }),
        ...(dto.placeId !== undefined && { placeId: dto.placeId }),
        ...(dto.departament !== undefined && { departament: dto.departament }),
        ...(dto.reference !== undefined && { reference: dto.reference }),
        ...(dto.contact !== undefined && { contact: dto.contact }),
      },
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwner(userId, id);
    await this.prisma.address.delete({ where: { id } });
    return { message: 'Dirección eliminada' };
  }

  private async assertOwner(userId: string, id: string) {
    const address = await this.prisma.address.findUnique({ where: { id } });
    if (!address) throw new NotFoundException('Dirección no encontrada');
    if (address.userId !== userId) throw new ForbiddenException();
  }
}
