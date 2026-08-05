import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as crypto from 'crypto';
import { AppleMobileAuthDto } from './dto/apple-mobile-auth.dto';
import { LoginDto } from './dto/login.dto';
import { SignUpDto } from './dto/sign-up.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from 'src/users/users.service';
import * as bcrypt from 'bcrypt';
import type { User } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { MailService } from 'src/mail/mail.service';
import { WhatsappService } from 'src/whatsapp/whatsapp.service';
import { ConfigService } from '@nestjs/config';

interface PendingCode {
  code: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
}

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

function makeCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizePhone(raw: string): string {
  const stripped = raw.replace(/[\s\-().]/g, '');
  return stripped.startsWith('+') ? stripped : `+${stripped}`;
}

// JWKS público de Apple. `createRemoteJWKSet` cachea las llaves y refresca
// automáticamente cuando Apple las rota, así que se crea una sola vez.
const APPLE_ISSUER = 'https://appleid.apple.com';
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

@Injectable()
export class AuthService {
  private readonly pendingEmailCodes  = new Map<string, PendingCode>();
  private readonly pendingPhoneCodes  = new Map<string, PendingCode>();

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly whatsappService: WhatsappService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Email OTP ─────────────────────────────────────────────────────────────

  async sendVerificationCode(email: string): Promise<void> {
    const existing = await this.usersService.findOneByEmail(email);
    if (existing) throw new ConflictException('Este correo ya está registrado.');

    const code = makeCode();
    this.pendingEmailCodes.set(email.toLowerCase(), { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, sentAt: Date.now() });
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

    const existing = this.pendingPhoneCodes.get(userId);
    if (existing) {
      const elapsed = Date.now() - existing.sentAt;
      if (elapsed < RESEND_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
        throw new BadRequestException(`Espera ${waitSeconds} segundos antes de solicitar un nuevo código.`);
      }
    }

    const code = makeCode();
    this.pendingPhoneCodes.set(userId, { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, sentAt: Date.now() });

    const text = `Tu código de verificación Oktava es: *${code}*\nExpira en 10 minutos.`;
    await this.whatsappService.sendText(user.phone, text);
  }

  async verifyPhone(userId: string, code: string): Promise<Omit<User, 'password' | 'createdAt' | 'updatedAt' | 'lastLogin'>> {
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

    const updated = await this.usersService.findOneById(userId);
    const { password: _, createdAt, updatedAt, lastLogin, ...result } = updated!;
    return result;
  }

  async getMe(userId: string): Promise<Omit<User, 'password' | 'createdAt' | 'updatedAt' | 'lastLogin'>> {
    const user = await this.usersService.findOneById(userId);
    if (!user) throw new NotFoundException('Usuario no encontrado.');
    const { password: _, createdAt, updatedAt, lastLogin, ...result } = user;
    return result;
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
      phone: dto.phone ? normalizePhone(dto.phone) : undefined,
      password: hashedPassword,
    });
    return this.generateTokenResponse(createdUser);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const phone = normalizePhone(dto.phone);
    const existing = await this.usersService.findOneByPhone(phone);
    if (existing && existing.id !== userId) {
      throw new ConflictException('Este número ya está registrado por otro usuario.');
    }
    await this.usersService.updatePhone(userId, phone);
    return { message: 'Perfil actualizado.' };
  }

  async googleLogin(googleUser: { email: string; firstName: string; lastName: string }) {
    const user = await this.usersService.findOrCreateGoogleUser(googleUser);
    const { password: _, ...userWithoutPassword } = user;
    return this.generateTokenResponse(userWithoutPassword);
  }

  async googleMobileLogin(idToken: string) {
    const mobileWebClientId = this.configService.get<string>('GOOGLE_MOBILE_WEB_CLIENT_ID');
    const mobileIosClientId = this.configService.get<string>('GOOGLE_MOBILE_IOS_CLIENT_ID');
    const allowedAudiences = [mobileWebClientId, mobileIosClientId].filter(
      (v): v is string => !!v,
    );

    console.log('[googleMobileLogin] audiences permitidos:', allowedAudiences);
    console.log('[googleMobileLogin] idToken recibido (primeros 30):', idToken?.slice(0, 30));

    try {
      const [, payloadB64] = idToken.split('.');
      const decoded = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
      console.log('[googleMobileLogin] token aud:', decoded.aud);
      console.log('[googleMobileLogin] token iss:', decoded.iss);
      console.log('[googleMobileLogin] token email:', decoded.email);
      console.log('[googleMobileLogin] token exp:', new Date(decoded.exp * 1000).toISOString());
      console.log('[googleMobileLogin] now:', new Date().toISOString());
    } catch (e) {
      console.log('[googleMobileLogin] No se pudo decodificar el JWT manualmente:', e);
    }

    if (allowedAudiences.length === 0) {
      console.error('[googleMobileLogin] No hay GOOGLE_MOBILE_WEB_CLIENT_ID ni GOOGLE_MOBILE_IOS_CLIENT_ID configurados');
      throw new UnauthorizedException('Configuración de Google para móvil ausente.');
    }

    const client = new OAuth2Client();

    let payload: TokenPayload | undefined;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: allowedAudiences });
      payload = ticket.getPayload();
      console.log('[googleMobileLogin] verifyIdToken OK. payload.email:', payload?.email);
    } catch (err) {
      console.error('[googleMobileLogin] verifyIdToken FALLÓ:', err);
      throw new UnauthorizedException('Token de Google inválido o expirado.');
    }

    if (!payload?.email) {
      console.error('[googleMobileLogin] payload sin email:', payload);
      throw new UnauthorizedException('No se pudo obtener el email desde Google.');
    }

    try {
      const user = await this.usersService.findOrCreateGoogleUser({
        email: payload.email,
        firstName: payload.given_name ?? '',
        lastName: payload.family_name ?? '',
        googleId: payload.sub,
      });
      console.log('[googleMobileLogin] findOrCreateGoogleUser OK. userId:', user.id);

      const { password: _, ...userWithoutPassword } = user;
      return this.generateTokenResponse(userWithoutPassword);
    } catch (err) {
      console.error('[googleMobileLogin] findOrCreateGoogleUser / generateTokenResponse FALLÓ:', err);
      throw err;
    }
  }

  async appleMobileLogin(dto: AppleMobileAuthDto) {
    const expectedAudience = this.configService.get<string>('APPLE_CLIENT_ID');
    if (!expectedAudience) {
      throw new UnauthorizedException('Configuración de Apple para móvil ausente.');
    }

    // Verificar firma, emisor y audiencia (bundle id) del identityToken.
    let payload: Record<string, any>;
    try {
      const verified = await jwtVerify(dto.identityToken, appleJwks, {
        issuer: APPLE_ISSUER,
        audience: expectedAudience,
      });
      payload = verified.payload as Record<string, any>;
    } catch {
      throw new UnauthorizedException('Token de Apple inválido o expirado.');
    }

    // `sub` es el Apple user id estable. El email solo llega en el token la 1ª vez;
    // luego se toma el guardado en BD (via appleId).
    const appleId = (payload.sub as string) ?? dto.appleUserId;
    if (!appleId) {
      throw new UnauthorizedException('No se pudo identificar la cuenta de Apple.');
    }

    const email = (payload.email as string) ?? dto.email;
    if (!email) {
      throw new UnauthorizedException('No se pudo obtener el email desde Apple.');
    }

    const user = await this.usersService.findOrCreateAppleUser({
      appleId,
      email,
      firstName: dto.firstName ?? '',
      lastName: dto.lastName ?? '',
    });

    const { password: _, ...userWithoutPassword } = user;
    return this.generateTokenResponse(userWithoutPassword);
  }

  // ─── Forgot / Reset Password ───────────────────────────────────────────────

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findOneByEmail(email);

    // Respuesta siempre igual: no revelar si el email existe
    if (!user) return;

    // Código de 6 dígitos. Se hashea atado al email para que el hash
    // sea único por usuario incluso si dos usuarios reciben el mismo código.
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const hashedToken = crypto
      .createHash('sha256')
      .update(`${user.email.toLowerCase()}:${code}`)
      .digest('hex');
    const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    await this.usersService.setPasswordResetToken(user.id, hashedToken, expiry);
    await this.mailService.sendPasswordResetEmail(user.email, code);
  }

  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    const user = await this.usersService.findOneByEmail(email);

    const hashedToken = user
      ? crypto.createHash('sha256').update(`${user.email.toLowerCase()}:${code}`).digest('hex')
      : null;

    // Validación unificada: no revelar si el email existe, el código es incorrecto
    // o el código expiró. Todos los casos dan el mismo error.
    if (
      !user ||
      !user.passwordResetToken ||
      !user.passwordResetExpiry ||
      user.passwordResetToken !== hashedToken ||
      user.passwordResetExpiry < new Date()
    ) {
      throw new BadRequestException('El código es inválido o ha expirado.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.usersService.updatePasswordAndClearResetToken(user.id, hashedPassword);
  }

  private generateTokenResponse(user: Omit<User, 'password'>) {
    this.usersService.updateLastLogin(user.id);
    const payload = { sub: user.id, email: user.email, phone: user.phone, role: user.role };
    const { createdAt, updatedAt, lastLogin, ...newUser } = user;
    return { accessToken: this.jwtService.sign(payload), user: newUser };
  }
}
