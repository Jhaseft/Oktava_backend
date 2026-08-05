import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';

function mapBanner(b: any) {
  return {
    id: b.id,
    imageUrl: b.imageUrl,
    sortOrder: b.sortOrder ?? 0,
    isActive: b.isActive,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

@Injectable()
export class BannersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /** Banners activos ordenados para el carrusel del Home. */
  async findAll() {
    const banners = await this.prisma.banner.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return banners.map(mapBanner);
  }

  /** Todos los banners (incluye inactivos) para el panel admin. */
  async findAllAdmin() {
    const banners = await this.prisma.banner.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return banners.map(mapBanner);
  }

  async create(dto: CreateBannerDto) {
    const created = await this.prisma.banner.create({
      data: {
        imageUrl: dto.imageUrl.trim(),
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
    return mapBanner(created);
  }

  async update(id: string, dto: UpdateBannerDto) {
    const existing = await this.prisma.banner.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Banner ${id} not found`);

    const updated = await this.prisma.banner.update({
      where: { id },
      data: {
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl.trim() }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
    return mapBanner(updated);
  }

  async remove(id: string) {
    const existing = await this.prisma.banner.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Banner ${id} not found`);

    await this.prisma.banner.delete({ where: { id } });
    if (existing.imageUrl) {
      await this.cloudinary.deleteByUrl(existing.imageUrl).catch(() => {});
    }
    return { message: `Banner ${id} deleted` };
  }
}
