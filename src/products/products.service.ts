import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-+/g, '-');
}

function mapCategory(c: any) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    imageUrl: c.imageUrl ?? null,
    isActive: c.isActive,
    productCount: c._count?.products ?? undefined,
  };
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Private product mapper ────────────────────────────────────────────────

  private mapProduct(product: any) {
    const baseVariant = product.variants?.[0];
    return {
      id: product.id,
      name: product.name,
      description: product.description ?? null,
      imageUrl: product.imageUrl ?? null,
      categoryId: product.categoryId,
      category: product.category?.name ?? null,
      price: baseVariant?.price != null ? Number(baseVariant.price) : null,
      status: product.isAvailable ? 'active' : 'inactive',
      isAvailable: product.isAvailable,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  // ─── Categories — public ───────────────────────────────────────────────────

  async findAllCategories() {
    const categories = await this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    return categories.map(mapCategory);
  }

  // ─── Categories — admin ────────────────────────────────────────────────────

  async findAllCategoriesAdmin() {
    const categories = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    return categories.map(mapCategory);
  }

  async createCategory(dto: CreateCategoryDto) {
    const slug = dto.slug?.trim() || slugify(dto.name);
    try {
      const created = await this.prisma.category.create({
        data: {
          name: dto.name.trim(),
          slug,
          imageUrl: dto.imageUrl?.trim() || null,
        },
      });
      return mapCategory(created);
    } catch (e: any) {
      if (e.code === 'P2002') {
        throw new ConflictException(`El slug "${slug}" ya está en uso.`);
      }
      throw e;
    }
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Category ${id} not found`);

    try {
      const updated = await this.prisma.category.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.slug !== undefined && { slug: dto.slug.trim() }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.imageUrl !== undefined && {
            imageUrl: dto.imageUrl?.trim() || null,
          }),
        },
      });
      return mapCategory(updated);
    } catch (e: any) {
      if (e.code === 'P2002') {
        throw new ConflictException('El slug ya está en uso por otra categoría.');
      }
      throw e;
    }
  }

  async softDeleteCategory(id: string) {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Category ${id} not found`);

    await this.prisma.category.update({
      where: { id },
      data: { isActive: false },
    });
    return { message: `Category ${id} deactivated` };
  }

  // ─── Products ──────────────────────────────────────────────────────────────

  async findAllProducts() {
    const products = await this.prisma.product.findMany({
      include: {
        category: true,
        variants: {
          orderBy: { id: 'asc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return products.map((p) => this.mapProduct(p));
  }

  async findOneProduct(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        variants: { orderBy: { id: 'asc' } },
      },
    });

    if (!product) throw new NotFoundException(`Product ${id} not found`);

    const { variants, ...rest } = product as typeof product & {
      variants: { id: string; name: string; price: any; isAvailable: boolean }[];
    };

    return {
      ...this.mapProduct({ ...rest, variants }),
      variants: variants.map((v) => ({
        id: v.id,
        name: v.name,
        price: Number(v.price),
        isAvailable: v.isAvailable,
      })),
    };
  }

  async create(dto: CreateProductDto) {
    const { price, ...productFields } = dto;

    const product = await this.prisma.$transaction(async (tx) => {
      return tx.product.create({
        data: {
          name: productFields.name,
          description: productFields.description,
          imageUrl: productFields.imageUrl,
          categoryId: productFields.categoryId,
          isAvailable: productFields.isAvailable ?? true,
          variants: {
            create: { name: 'Base', price, isAvailable: true },
          },
        },
        include: {
          category: true,
          variants: { orderBy: { id: 'asc' }, take: 1 },
        },
      });
    });

    return this.mapProduct(product);
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOneProduct(id);

    const { price, ...productFields } = dto;

    const updatedProduct = await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: {
          ...(productFields.name !== undefined && { name: productFields.name }),
          ...(productFields.description !== undefined && {
            description: productFields.description,
          }),
          ...(productFields.imageUrl !== undefined && {
            imageUrl: productFields.imageUrl,
          }),
          ...(productFields.categoryId !== undefined && {
            categoryId: productFields.categoryId,
          }),
          ...(productFields.isAvailable !== undefined && {
            isAvailable: productFields.isAvailable,
          }),
        },
      });

      if (price !== undefined) {
        const baseVariant = await tx.productVariant.findFirst({
          where: { productId: id },
          orderBy: { id: 'asc' },
        });

        if (baseVariant) {
          await tx.productVariant.update({
            where: { id: baseVariant.id },
            data: { price },
          });
        } else {
          await tx.productVariant.create({
            data: { productId: id, name: 'Base', price, isAvailable: true },
          });
        }
      }

      return tx.product.findUnique({
        where: { id },
        include: {
          category: true,
          variants: { orderBy: { id: 'asc' }, take: 1 },
        },
      });
    });

    return this.mapProduct(updatedProduct);
  }

  async softDelete(id: string) {
    await this.findOneProduct(id);
    await this.prisma.product.update({
      where: { id },
      data: { isAvailable: false },
    });
    return { message: `Product ${id} deactivated` };
  }
}
