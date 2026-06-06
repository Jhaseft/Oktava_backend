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
  private readonly baseUrl: string;
  private readonly instance: string;
  private readonly apiKey: string;
  private readonly devMode: boolean;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('EVOLUTION_API_URL') ?? '';
    this.instance = this.configService.get<string>('EVOLUTION_API_INSTANCE') ?? '';
    this.apiKey = this.configService.get<string>('EVOLUTION_API_KEY') ?? '';
    this.devMode = this.configService.get<string>('WHATSAPP_DEV_MODE') === 'true';

    const configured = !!(this.baseUrl && this.instance && this.apiKey);

    if (this.devMode) {
      this.logger.warn(
        'WHATSAPP_DEV_MODE=true — los mensajes NO se enviarán. Solo se imprimirán en consola.',
      );
    } else if (!configured) {
      this.logger.error(
        'Evolution API NO configurada. Define EVOLUTION_API_URL, EVOLUTION_API_INSTANCE y EVOLUTION_API_KEY en .env, ' +
        'o activa WHATSAPP_DEV_MODE=true para desarrollo local.',
      );
    } else {
      this.logger.log(`Evolution API lista → ${this.baseUrl} | instancia: ${this.instance}`);
    }
  }

  async sendText(phoneNumber: string, text: string): Promise<void> {
    const configured = !!(this.baseUrl && this.instance && this.apiKey);

    if (!configured) {
      if (this.devMode) {
        this.logger.warn(
          `[DEV MODE] WhatsApp simulado → ${phoneNumber}\n${text}`,
        );
        return;
      }
      throw new ServiceUnavailableException(
        'El servicio de WhatsApp no está configurado. Contacte al administrador.',
      );
    }

    const url = `${this.baseUrl}/message/sendText/${this.instance}`;
    const number = phoneNumber.replace(/^\+/, '');

    this.logger.log(`Enviando WhatsApp a ${number} vía ${this.baseUrl}`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.apiKey,
        },
        body: JSON.stringify({ number, text }),
      });
    } catch (err) {
      this.logger.error(`Error de red al llamar Evolution API: ${(err as Error).message}`);
      throw new InternalServerErrorException('No se pudo conectar con Evolution API');
    }

    const responseBody = await response.text();

    if (!response.ok) {
      this.logger.error(
        `Evolution API rechazó la solicitud [${response.status}]: ${responseBody}`,
      );

      let parsed: { response?: { message?: string } } = {};
      try { parsed = JSON.parse(responseBody); } catch { /* not JSON */ }

      if (parsed?.response?.message === 'Connection Closed') {
        throw new ServiceUnavailableException(
          'La instancia de WhatsApp no está conectada. Contacte al administrador.',
        );
      }

      throw new InternalServerErrorException('Error al enviar mensaje de WhatsApp');
    }

    this.logger.log(`WhatsApp OTP enviado a ${number}`);
  }
}
