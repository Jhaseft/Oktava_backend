import { Controller, Get, Post, Body, HttpCode, HttpStatus, HttpException, UseGuards, Req, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import type { Request, Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto) {
    const user = await this.authService.validateUser(loginDto);
    if(!user){
      throw new HttpException('Invalid credentials', HttpStatus.UNAUTHORIZED);
    }
    return this.authService.login(user);
  }

  @Post('sign-up')
  @HttpCode(HttpStatus.CREATED)
  async signUp(@Body() createUserDto: CreateUserDto) {
    return this.authService.register(createUserDto);
  }

  @Get('google')
  @UseGuards(GoogleAuthGuard)
  googleAuth() {
    // Passport redirige automáticamente a Google
  }

  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const googleUser = req.user as { email: string; firstName: string; lastName: string };
    const result = await this.authService.googleLogin(googleUser);
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    const userEncoded = encodeURIComponent(
      Buffer.from(JSON.stringify(result.user)).toString('base64'),
    );
    return res.redirect(`${frontendUrl}/auth/callback?token=${result.accessToken}&user=${userEncoded}`);
  }
}
