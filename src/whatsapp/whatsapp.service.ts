import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly apiVersion: string;
  private readonly templateName: string;
  private readonly templateLang: string;
  private readonly devMode: boolean;

  constructor(private configService: ConfigService) {
    this.token = this.configService.get<string>('WHATSAPP_API_TOKEN') ?? '';
    this.phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID') ?? '';
    this.apiVersion = this.configService.get<string>('WHATSAPP_API_VERSION') ?? 'v21.0';
    this.templateName = this.configService.get<string>('WHATSAPP_OTP_TEMPLATE') ?? 'oktava_otp';
    this.templateLang = this.configService.get<string>('WHATSAPP_OTP_LANG') ?? 'es_AR';
    this.devMode = this.configService.get<string>('WHATSAPP_DEV_MODE') === 'true';

    const configured = !!(this.token && this.phoneNumberId);

    if (this.devMode) {
      this.logger.warn(
        'WHATSAPP_DEV_MODE=true — los mensajes NO se enviarán. Solo se imprimirán en consola.',
      );
    } else if (!configured) {
      this.logger.error(
        'WhatsApp Cloud API NO configurada. Define WHATSAPP_API_TOKEN y WHATSAPP_PHONE_NUMBER_ID en .env, ' +
        'o activa WHATSAPP_DEV_MODE=true para desarrollo local.',
      );
    } else {
      this.logger.log(
        `WhatsApp Cloud API lista → graph.facebook.com/${this.apiVersion}/${this.phoneNumberId} | plantilla: ${this.templateName}`,
      );
    }
  }

  /**
   * Envía el código OTP usando la plantilla oficial de WhatsApp Cloud API.
   * La plantilla `oktava_otp` incluye el código en el cuerpo y en el botón URL.
   */
  async sendOtp(phoneNumber: string, code: string): Promise<void> {
    const configured = !!(this.token && this.phoneNumberId);
    const number = phoneNumber.replace(/[^\d]/g, '');

    if (!configured) {
      if (this.devMode) {
        this.logger.warn(`[DEV MODE] WhatsApp OTP simulado → ${number}: ${code}`);
        return;
      }
      throw new ServiceUnavailableException(
        'El servicio de WhatsApp no está configurado. Contacte al administrador.',
      );
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to: number,
      type: 'template',
      template: {
        name: this.templateName,
        language: { code: this.templateLang },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: code }],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: code }],
          },
        ],
      },
    };

    this.logger.log(`Enviando WhatsApp OTP a ${number} vía WhatsApp Cloud API`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.error(`Error de red al llamar WhatsApp Cloud API: ${(err as Error).message}`);
      throw new InternalServerErrorException('No se pudo conectar con WhatsApp Cloud API');
    }

    const responseBody = await response.text();

    if (!response.ok) {
      this.logger.error(
        `WhatsApp Cloud API rechazó la solicitud [${response.status}]: ${responseBody}`,
      );
      throw new InternalServerErrorException('Error al enviar mensaje de WhatsApp');
    }

    this.logger.log(`WhatsApp OTP enviado a ${number}`);
  }
}
