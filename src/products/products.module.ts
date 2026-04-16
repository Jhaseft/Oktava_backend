import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

// PrismaService is provided globally via PrismaModule registered in AppModule.
@Module({
  imports: [CloudinaryModule],
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
