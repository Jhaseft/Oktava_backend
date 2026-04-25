import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: config.get<string>('EMAIL_HOST'),
      port: config.get<number>('EMAIL_PORT') ?? 587,
      secure: false,
      auth: {
        user: config.get<string>('EMAIL_USER'),
        pass: config.get<string>('EMAIL_PASS'),
      },
    });
  }

  async sendVerificationCode(to: string, code: string): Promise<void> {
    const from = this.config.get<string>('EMAIL_FROM') ?? 'Oktava <noreply@oktava.com>';

    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:16px;padding:40px 32px">
        <div style="text-align:center;margin-bottom:32px">
          <span style="display:inline-block;background:#ef4444;color:#fff;font-size:22px;font-weight:900;letter-spacing:4px;padding:8px 20px;border-radius:8px">OKTAVA</span>
        </div>
        <h2 style="font-size:20px;font-weight:700;margin:0 0 8px">Verifica tu correo</h2>
        <p style="color:#a1a1aa;font-size:14px;margin:0 0 32px">Ingresa este código en la pantalla de registro. Expira en <strong style="color:#fff">10 minutos</strong>.</p>
        <div style="background:#1a1a1a;border-radius:12px;padding:28px;text-align:center;letter-spacing:16px;font-size:40px;font-weight:900;color:#ef4444;border:1px solid #27272a">
          ${code}
        </div>
        <p style="color:#52525b;font-size:12px;margin:24px 0 0;text-align:center">Si no solicitaste esto, ignora este mensaje.</p>
      </div>
    `;

    try {
      await this.transporter.sendMail({ from, to, subject: `${code} es tu código de verificación — Oktava`, html });
    } catch (err) {
      console.error('Mail send error:', err);
      throw new InternalServerErrorException('No se pudo enviar el correo de verificación.');
    }
  }
}
