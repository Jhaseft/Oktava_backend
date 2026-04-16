import { v2 as cloudinary } from 'cloudinary';
import { ConfigService } from '@nestjs/config';

export const CLOUDINARY = 'CLOUDINARY';

export const CloudinaryProvider = {
  provide: CLOUDINARY,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    return cloudinary.config({
      cloud_url: configService.get<string>('CLOUDINARY_URL'),
    });
  },
};
