import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

const ALLOWED_MIME = /image\/(jpeg|jpg|png|gif|webp)/;
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

@Controller()
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // ─── Categories — public ───────────────────────────────────────────────────

  /** GET /categories — active categories only (for storefront + product form) */
  @Get('categories')
  findAllCategories() {
    return this.productsService.findAllCategories();
  }

  // ─── Categories — admin ────────────────────────────────────────────────────

  /** GET /categories/admin — all categories including inactive */
  @Get('categories/admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  findAllCategoriesAdmin() {
    return this.productsService.findAllCategoriesAdmin();
  }

  /** POST /categories */
  @Post('categories')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.productsService.createCategory(dto);
  }

  /** PATCH /categories/:id */
  @Patch('categories/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.productsService.updateCategory(id, dto);
  }

  /** DELETE /categories/:id — soft-delete (sets isActive = false) */
  @Delete('categories/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  softDeleteCategory(@Param('id') id: string) {
    return this.productsService.softDeleteCategory(id);
  }

  // ─── Products — public ─────────────────────────────────────────────────────

  @Get('products')
  findAllProducts() {
    return this.productsService.findAllProducts();
  }

  @Get('products/:id')
  findProductById(@Param('id') id: string) {
    return this.productsService.findOneProduct(id);
  }

  // ─── Products — admin ──────────────────────────────────────────────────────

  @Post('products/upload')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: join(process.cwd(), 'public', 'uploads'),
        filename: (_req, file, cb) => {
          const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
          cb(null, `product-${unique}${extname(file.originalname).toLowerCase()}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.test(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Solo se permiten imágenes (jpg, png, gif, webp)'), false);
        }
      },
      limits: { fileSize: MAX_SIZE_BYTES },
    }),
  )
  uploadImage(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new BadRequestException('No se recibió ningún archivo');
    const host = `${req.protocol}://${req.get('host')}`;
    return { url: `${host}/uploads/${file.filename}` };
  }

  @Post('products')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Patch('products/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }

  @Delete('products/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  softDelete(@Param('id') id: string) {
    return this.productsService.softDelete(id);
  }
}
