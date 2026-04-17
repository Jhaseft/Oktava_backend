import { v2 as cloudinary } from 'cloudinary';
import { ConfigService } from '@nestjs/config';

export const CLOUDINARY = 'CLOUDINARY';

export const CloudinaryProvider = {
  provide: CLOUDINARY,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const url = configService.get<string>('CLOUDINARY_URL') ?? '';
    // Parse cloudinary://api_key:api_secret@cloud_name
    const match = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(url);
    if (!match) throw new Error(`CLOUDINARY_URL inválida: ${url}`);
    return cloudinary.config({
      api_key: match[1],
      api_secret: match[2],
      cloud_name: match[3],
    });
  },
};
