import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LoginDto } from './dto/login.dto';
import { SignUpDto } from './dto/sign-up.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from 'src/users/users.service';
import * as bcrypt from 'bcrypt';
import type { User } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { MailService } from 'src/mail/mail.service';
import { WhatsappService } from 'src/whatsapp/whatsapp.service';

interface PendingCode {
  code: string;
  expiresAt: number;
  attempts: number;
}

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function makeCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

@Injectable()
export class AuthService {
  private readonly pendingEmailCodes  = new Map<string, PendingCode>();
  private readonly pendingPhoneCodes  = new Map<string, PendingCode>();

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly whatsappService: WhatsappService,
  ) {}

  // ─── Email OTP ─────────────────────────────────────────────────────────────

  async sendVerificationCode(email: string): Promise<void> {
    const existing = await this.usersService.findOneByEmail(email);
    if (existing) throw new ConflictException('Este correo ya está registrado.');

    const code = makeCode();
    this.pendingEmailCodes.set(email.toLowerCase(), { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });
    await this.mailService.sendVerificationCode(email, code);
  }

  private consumeEmailCode(email: string, code: string): void {
    const key = email.toLowerCase();
    const pending = this.pendingEmailCodes.get(key);
    if (!pending) throw new BadRequestException('Solicita un nuevo código de verificación.');
    if (Date.now() > pending.expiresAt) {
      this.pendingEmailCodes.delete(key);
      throw new BadRequestException('El código expiró. Solicita uno nuevo.');
    }
    pending.attempts += 1;
    if (pending.attempts > MAX_ATTEMPTS) {
      this.pendingEmailCodes.delete(key);
      throw new BadRequestException('Demasiados intentos. Solicita un nuevo código.');
    }
    if (pending.code !== code) throw new BadRequestException('Código incorrecto.');
    this.pendingEmailCodes.delete(key);
  }

  // ─── Phone OTP ─────────────────────────────────────────────────────────────

  async sendPhoneVerificationCode(userId: string): Promise<void> {
    const user = await this.usersService.findOneById(userId);
    if (!user) throw new NotFoundException('Usuario no encontrado.');
    if (!user.phone) throw new BadRequestException('No tienes un número de teléfono registrado.');
    if (user.phoneVerified) throw new BadRequestException('Tu teléfono ya está verificado.');

    const code = makeCode();
    this.pendingPhoneCodes.set(userId, { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });

    const text = `Tu código de verificación Oktava es: *${code}*\nExpira en 10 minutos.`;
    await this.whatsappService.sendText(user.phone, text);
  }

  async verifyPhone(userId: string, code: string): Promise<void> {
    const pending = this.pendingPhoneCodes.get(userId);
    if (!pending) throw new BadRequestException('Solicita un nuevo código de verificación.');
    if (Date.now() > pending.expiresAt) {
      this.pendingPhoneCodes.delete(userId);
      throw new BadRequestException('El código expiró. Solicita uno nuevo.');
    }
    pending.attempts += 1;
    if (pending.attempts > MAX_ATTEMPTS) {
      this.pendingPhoneCodes.delete(userId);
      throw new BadRequestException('Demasiados intentos. Solicita un nuevo código.');
    }
    if (pending.code !== code) throw new BadRequestException('Código incorrecto.');
    this.pendingPhoneCodes.delete(userId);
    await this.usersService.setPhoneVerified(userId);
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
    this.consumeEmailCode(dto.email, dto.verificationCode);

    const [existingEmail, existingPhone] = await Promise.all([
      this.usersService.findOneByEmail(dto.email),
      dto.phone ? this.usersService.findOneByPhone(dto.phone) : null,
    ]);
    if (existingEmail) throw new ConflictException('Este correo ya está registrado.');
    if (existingPhone) throw new ConflictException('Este número de teléfono ya está registrado.');

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const createdUser = await this.usersService.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      phone: dto.phone || undefined,
      password: hashedPassword,
    });
    return this.generateTokenResponse(createdUser);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (dto.phone) {
      const existing = await this.usersService.findOneByPhone(dto.phone);
      if (existing && existing.id !== userId) {
        throw new ConflictException('Este número ya está registrado por otro usuario.');
      }
    }
    await this.usersService.updatePhone(userId, dto.phone);
    return { message: 'Perfil actualizado.' };
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
