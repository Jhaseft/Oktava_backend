import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';
import { LoginDto } from './dto/login.dto';
import { SignUpDto } from './dto/sign-up.dto';
import { SendVerificationDto } from './dto/send-verification.dto';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import type { Request, Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('send-verification')
  @HttpCode(HttpStatus.OK)
  async sendVerification(@Body() dto: SendVerificationDto) {
    await this.authService.sendVerificationCode(dto.email);
    return { message: 'Código enviado. Revisa tu correo.' };
  }

  @Post('sign-up')
  @HttpCode(HttpStatus.CREATED)
  async signUp(@Body() dto: SignUpDto) {
    return this.authService.register(dto);
  }

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto) {
    const user = await this.authService.validateUser(loginDto);
    if (!user) throw new HttpException('Invalid credentials', HttpStatus.UNAUTHORIZED);
    return this.authService.login(user);
  }

  @Get('google')
  @UseGuards(GoogleAuthGuard)
  googleAuth() { /* Passport handles the redirect */ }

  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const googleUser = req.user as { email: string; firstName: string; lastName: string };
    const result = await this.authService.googleLogin(googleUser);
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    const userEncoded = encodeURIComponent(
      Buffer.from(JSON.stringify(result.user)).toString('base64'),
    );
    return res.redirect(
      `${frontendUrl}/auth/callback?token=${result.accessToken}&user=${userEncoded}`,
    );
  }
}
