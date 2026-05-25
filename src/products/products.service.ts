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
import { CreateOptionGroupDto } from './dto/create-option-group.dto';
import { CreateOptionDto } from './dto/create-option.dto';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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
    sortOrder: c.sortOrder ?? 0,
    productCount: c._count?.products ?? undefined,
  };
}

function mapOption(o: any) {
  return {
    id: o.id,
    name: o.name,
    extraPrice: Number(o.extraPrice),
    isAvailable: o.isAvailable,
    sortOrder: o.sortOrder,
    imageUrl: o.imageUrl ?? null,
  };
}

function mapOptionGroup(g: any) {
  return {
    id: g.id,
    name: g.name,
    isRequired: g.isRequired,
    minSelections: g.minSelections,
    maxSelections: g.maxSelections,
    sortOrder: g.sortOrder,
    options: (g.options ?? []).map(mapOption),
  };
}

const PRODUCT_INCLUDE = {
  category: true,
  optionGroups: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      options: { orderBy: { sortOrder: 'asc' as const } },
    },
  },
};

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Private product mapper ────────────────────────────────────────────────

  private mapProduct(product: any) {
    return {
      id: product.id,
      name: product.name,
      description: product.description ?? null,
      includes: product.includes ?? null,
      imageUrl: product.imageUrl ?? null,
      categoryId: product.categoryId,
      category: product.category?.name ?? null,
      price: product.price == null ? null : Number(product.price),
      status: product.isAvailable ? 'active' : 'inactive',
      isAvailable: product.isAvailable,
      optionGroups: (product.optionGroups ?? []).map(mapOptionGroup),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  // ─── Categories — public ───────────────────────────────────────────────────

  async findAllCategories() {
    const categories = await this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return categories.map(mapCategory);
  }

  // ─── Categories — admin ────────────────────────────────────────────────────

  async findAllCategoriesAdmin() {
    const categories = await this.prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
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
          sortOrder: dto.sortOrder ?? 0,
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
          ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
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
      where: { isAvailable: true },
      include: PRODUCT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return products.map((p) => this.mapProduct(p));
  }

  async findAllProductsAdmin() {
    const products = await this.prisma.product.findMany({
      include: PRODUCT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return products.map((p) => this.mapProduct(p));
  }

  async findOneProduct(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: PRODUCT_INCLUDE,
    });

    if (!product) throw new NotFoundException(`Product ${id} not found`);

    return this.mapProduct(product);
  }

  async create(dto: CreateProductDto) {
    const { optionGroups, ...productFields } = dto;

    const product = await this.prisma.product.create({
      data: {
        name: productFields.name,
        description: productFields.description,
        includes: productFields.includes,
        imageUrl: productFields.imageUrl,
        categoryId: productFields.categoryId,
        price: productFields.price,
        isAvailable: productFields.isAvailable ?? true,
        ...(optionGroups?.length && {
          optionGroups: {
            create: optionGroups.map((g, gi) => ({
              name: g.name,
              isRequired: g.isRequired ?? true,
              minSelections: g.minSelections ?? 1,
              maxSelections: g.maxSelections ?? 1,
              sortOrder: g.sortOrder ?? gi,
              options: {
                create: (g.options ?? []).map((o, oi) => ({
                  name: o.name,
                  extraPrice: o.extraPrice ?? 0,
                  isAvailable: o.isAvailable ?? true,
                  sortOrder: o.sortOrder ?? oi,
                  ...(o.imageUrl && { imageUrl: o.imageUrl }),
                })),
              },
            })),
          },
        }),
      },
      include: PRODUCT_INCLUDE,
    });

    return this.mapProduct(product);
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOneProduct(id);

    const { optionGroups: _og, ...productFields } = dto;

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        ...(productFields.name !== undefined && { name: productFields.name }),
        ...(productFields.description !== undefined && { description: productFields.description }),
        ...(productFields.includes !== undefined && { includes: productFields.includes }),
        ...(productFields.imageUrl !== undefined && { imageUrl: productFields.imageUrl }),
        ...(productFields.categoryId !== undefined && { categoryId: productFields.categoryId }),
        ...(productFields.price !== undefined && { price: productFields.price }),
        ...(productFields.isAvailable !== undefined && { isAvailable: productFields.isAvailable }),
      },
      include: PRODUCT_INCLUDE,
    });

    return this.mapProduct(updated);
  }

  async softDelete(id: string) {
    await this.findOneProduct(id);
    await this.prisma.product.update({
      where: { id },
      data: { isAvailable: false },
    });
    return { message: `Product ${id} deactivated` };
  }

  async hardDelete(id: string) {
    await this.findOneProduct(id);
    await this.prisma.product.delete({ where: { id } });
    return { message: `Product ${id} permanently deleted` };
  }

  // ─── OptionGroups ──────────────────────────────────────────────────────────

  async createOptionGroup(productId: string, dto: CreateOptionGroupDto) {
    await this.findOneProduct(productId);

    const group = await this.prisma.optionGroup.create({
      data: {
        productId,
        name: dto.name,
        isRequired: dto.isRequired ?? true,
        minSelections: dto.minSelections ?? 1,
        maxSelections: dto.maxSelections ?? 1,
        sortOrder: dto.sortOrder ?? 0,
        options: {
          create: (dto.options ?? []).map((o, i) => ({
            name: o.name,
            extraPrice: o.extraPrice ?? 0,
            isAvailable: o.isAvailable ?? true,
            sortOrder: o.sortOrder ?? i,
            ...(o.imageUrl && { imageUrl: o.imageUrl }),
          })),
        },
      },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    });

    return mapOptionGroup(group);
  }

  async updateOptionGroup(groupId: string, dto: Partial<CreateOptionGroupDto>) {
    const existing = await this.prisma.optionGroup.findUnique({ where: { id: groupId } });
    if (!existing) throw new NotFoundException(`OptionGroup ${groupId} not found`);

    const updated = await this.prisma.optionGroup.update({
      where: { id: groupId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.isRequired !== undefined && { isRequired: dto.isRequired }),
        ...(dto.minSelections !== undefined && { minSelections: dto.minSelections }),
        ...(dto.maxSelections !== undefined && { maxSelections: dto.maxSelections }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    });

    return mapOptionGroup(updated);
  }

  async deleteOptionGroup(groupId: string) {
    const existing = await this.prisma.optionGroup.findUnique({ where: { id: groupId } });
    if (!existing) throw new NotFoundException(`OptionGroup ${groupId} not found`);

    await this.prisma.optionGroup.delete({ where: { id: groupId } });
    return { message: `OptionGroup ${groupId} deleted` };
  }

  // ─── Options ───────────────────────────────────────────────────────────────

  async createOption(groupId: string, dto: CreateOptionDto) {
    const group = await this.prisma.optionGroup.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException(`OptionGroup ${groupId} not found`);

    const option = await this.prisma.option.create({
      data: {
        groupId,
        name: dto.name,
        extraPrice: dto.extraPrice ?? 0,
        isAvailable: dto.isAvailable ?? true,
        sortOrder: dto.sortOrder ?? 0,
        ...(dto.imageUrl && { imageUrl: dto.imageUrl }),
      },
    });

    return mapOption(option);
  }

  async updateOption(groupId: string, optionId: string, dto: Partial<CreateOptionDto>) {
    const option = await this.prisma.option.findFirst({
      where: { id: optionId, groupId },
    });
    if (!option) throw new NotFoundException(`Option ${optionId} not found in group ${groupId}`);

    const updated = await this.prisma.option.update({
      where: { id: optionId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.extraPrice !== undefined && { extraPrice: dto.extraPrice }),
        ...(dto.isAvailable !== undefined && { isAvailable: dto.isAvailable }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl || null }),
      },
    });

    return mapOption(updated);
  }

  async deleteOption(groupId: string, optionId: string) {
    const option = await this.prisma.option.findFirst({
      where: { id: optionId, groupId },
    });
    if (!option) throw new NotFoundException(`Option ${optionId} not found in group ${groupId}`);

    await this.prisma.option.delete({ where: { id: optionId } });
    return { message: `Option ${optionId} deleted` };
  }
}
