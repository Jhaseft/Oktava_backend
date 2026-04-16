import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Private mapper ────────────────────────────────────────────────────────

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

  // ─── Categories ────────────────────────────────────────────────────────────

  async findAllCategories() {
    const categories = await this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });

    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      imageUrl: c.imageUrl ?? null,
      isActive: c.isActive,
    }));
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
            create: {
              name: 'Base',
              price,
              isAvailable: true,
            },
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
