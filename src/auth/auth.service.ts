import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { LoginDto } from './dto/login.dto';
import { SignUpDto } from './dto/sign-up.dto';
import { UsersService } from 'src/users/users.service';
import * as bcrypt from 'bcrypt';
import type { User } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { MailService } from 'src/mail/mail.service';

interface PendingCode {
  code: string;
  expiresAt: number;
  attempts: number;
}

const CODE_TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  private readonly pendingCodes = new Map<string, PendingCode>();

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
  ) {}

  // ─── Email verification ────────────────────────────────────────────────────

  async sendVerificationCode(email: string): Promise<void> {
    const existing = await this.usersService.findOneByEmail(email);
    if (existing) throw new ConflictException('Este correo ya está registrado.');

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    this.pendingCodes.set(email.toLowerCase(), {
      code,
      expiresAt: Date.now() + CODE_TTL_MS,
      attempts: 0,
    });

    await this.mailService.sendVerificationCode(email, code);
  }

  private verifyCode(email: string, code: string): void {
    const key = email.toLowerCase();
    const pending = this.pendingCodes.get(key);

    if (!pending) throw new BadRequestException('Solicita un nuevo código de verificación.');
    if (Date.now() > pending.expiresAt) {
      this.pendingCodes.delete(key);
      throw new BadRequestException('El código expiró. Solicita uno nuevo.');
    }

    pending.attempts += 1;
    if (pending.attempts > MAX_ATTEMPTS) {
      this.pendingCodes.delete(key);
      throw new BadRequestException('Demasiados intentos. Solicita un nuevo código.');
    }
    if (pending.code !== code) {
      throw new BadRequestException('Código incorrecto.');
    }

    this.pendingCodes.delete(key);
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  async validateUser({ email, password }: LoginDto): Promise<Omit<User, 'password'> | null> {
    const user = await this.usersService.findOneByEmail(email);
    if (user?.password && (await bcrypt.compare(password, user.password))) {
      const { password: _, ...result } = user;
      return result;
    }
    return null;
  }

  login(user: Omit<User, 'password'>) {
    return this.generateTokenResponse(user);
  }

  async register(dto: SignUpDto) {
    this.verifyCode(dto.email, dto.verificationCode);

    const existing = await this.usersService.findOneByEmail(dto.email);
    if (existing) throw new ConflictException('Este correo ya está registrado.');

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const createdUser = await this.usersService.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      phone: dto.phone,
      password: hashedPassword,
    });
    return this.generateTokenResponse(createdUser);
  }

  async googleLogin(googleUser: { email: string; firstName: string; lastName: string }) {
    const user = await this.usersService.findOrCreateGoogleUser(googleUser);
    const { password: _, ...userWithoutPassword } = user;
    return this.generateTokenResponse(userWithoutPassword);
  }

  private generateTokenResponse(user: Omit<User, 'password'>) {
    this.usersService.updateLastLogin(user.id);
    const payload = { sub: user.id, email: user.email, phone: user.phone, role: user.role };
    const { createdAt, updatedAt, lastLogin, ...newUser } = user;
    return { accessToken: this.jwtService.sign(payload), user: newUser };
  }
}
