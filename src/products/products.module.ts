import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

// PrismaService is provided globally via PrismaModule registered in AppModule.
@Module({
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
