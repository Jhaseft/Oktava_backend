import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from 'src/users/users.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  controllers: [AuthController],
  providers: [AuthService],
  imports: [UsersModule, JwtModule.registerAsync({
    imports:[ConfigModule],
    inject:[ConfigService],
    useFactory: (configService: ConfigService)=>({
      secret: configService.get<string>('JWT_SECRET'),
      signOptions: {expiresIn: '1d'}, //token dura un dia
    })
  })]
})
export class AuthModule {}
