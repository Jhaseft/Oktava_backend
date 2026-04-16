import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@Controller()
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // ─── Public endpoints (storefront + admin read) ────────────────────────────

  @Get('categories')
  findAllCategories() {
    return this.productsService.findAllCategories();
  }

  @Get('products')
  findAllProducts() {
    return this.productsService.findAllProducts();
  }

  @Get('products/:id')
  findProductById(@Param('id') id: string) {
    return this.productsService.findOneProduct(id);
  }

  // ─── Admin-only write endpoints ────────────────────────────────────────────

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
