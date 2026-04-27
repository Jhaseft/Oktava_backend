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

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('EVOLUTION_API_URL') ?? '';
    this.instance = this.configService.get<string>('EVOLUTION_API_INSTANCE') ?? '';
    this.apiKey = this.configService.get<string>('EVOLUTION_API_KEY') ?? '';

    if (!this.baseUrl || !this.instance || !this.apiKey) {
      this.logger.warn(
        'Evolution API no configurada (EVOLUTION_API_URL / EVOLUTION_API_INSTANCE / EVOLUTION_API_KEY vacíos)',
      );
    } else {
      this.logger.log(`Evolution API lista → ${this.baseUrl} | instancia: ${this.instance}`);
    }
  }

  async sendText(phoneNumber: string, text: string): Promise<void> {
    if (!this.baseUrl || !this.instance || !this.apiKey) {
      throw new ServiceUnavailableException(
        'El servicio de WhatsApp no está configurado en el servidor.',
      );
    }

    const url = `${this.baseUrl}/message/sendText/${this.instance}`;
    const number = phoneNumber.replace(/^\+/, '');

    this.logger.log(`→ POST ${url}  número: ${number}`);

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
    this.logger.log(`← ${response.status} ${response.statusText}: ${responseBody}`);

    if (!response.ok) {
      this.logger.error(`Evolution API rechazó la solicitud [${response.status}]: ${responseBody}`);
      throw new InternalServerErrorException('Error al enviar mensaje de WhatsApp');
    }

    this.logger.log(`WhatsApp enviado correctamente a ${number}`);
  }
}
