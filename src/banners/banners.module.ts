import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { BannersController } from './banners.controller';
import { BannersService } from './banners.service';

// PrismaService is provided globally via PrismaModule registered in AppModule.
@Module({
  imports: [CloudinaryModule],
  controllers: [BannersController],
  providers: [BannersService],
})
export class BannersModule {}
