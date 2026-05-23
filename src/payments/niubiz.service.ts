import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ─── Tipos internos ───────────────────────────────────────────────────────────

export interface NiubizSessionParams {
  amount: number;
  purchaseNumber: string;
  clientIp?: string;
  /** Email del usuario autenticado (para módulo antifraude MDD4). */
  userEmail?: string;
}

export interface NiubizSessionResult {
  sessionKey: string;
  raw: unknown;
}

export interface NiubizAuthorizeParams {
  transactionToken: string;
  purchaseNumber: string;
  amount: number;
  currency?: string;
}

// ─── Servicio ─────────────────────────────────────────────────────────────────

/**
 * Servicio de integración con la API de Niubiz (VisaNet Perú).
 * No depende de Prisma ni de ningún otro módulo del dominio.
 * Se puede testear de forma aislada inyectando solo ConfigService.
 *
 * Flujo de un pago completo:
 *   1. getSecurityToken()  → token de autenticación
 *   2. createSession()     → sessionKey para el widget JS del frontend
 *   3. (frontend)          → widget genera transactionToken
 *   4. authorize()         → autorización final del cargo
 */
@Injectable()
export class NiubizService {
  private readonly logger = new Logger(NiubizService.name);

  constructor(private readonly config: ConfigService) {}

  // ─── Token de seguridad ────────────────────────────────────────────────────

  /**
   * Obtiene el token de seguridad temporal de Niubiz.
   * Usa Basic Auth con las credenciales del .env.
   * Devuelve un string opaco que expira en ~5 minutos.
   */
  async getSecurityToken(): Promise<string> {
    const url = this.requireConfig('NIUBIZ_SECURITY_URL');
    const merchantId = this.requireConfig('NIUBIZ_MERCHANT_ID');
    const user = this.requireConfig('NIUBIZ_USER');
    const password = this.requireConfig('NIUBIZ_PASSWORD');

    const credentials = Buffer.from(`${user}:${password}`).toString('base64');

    const res = await fetch(`${url}?merchantId=${merchantId}`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'text/plain',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`[Niubiz] getSecurityToken ${res.status}: ${body}`);
      throw new InternalServerErrorException(
        'Niubiz: error al obtener el token de seguridad',
      );
    }

    return res.text();
  }

  // ─── Crear sesión de pago ──────────────────────────────────────────────────

  /**
   * Crea una sesión de pago en Niubiz y devuelve la sessionKey.
   * El frontend usa esta key para inicializar el widget JS de captura de tarjeta.
   */
  async createSession(params: NiubizSessionParams): Promise<NiubizSessionResult> {
    const token = await this.getSecurityToken();

    const merchantId = this.requireConfig('NIUBIZ_MERCHANT_ID');
    const currency = this.config.get<string>('NIUBIZ_CURRENCY') ?? 'PEN';
    const channel = this.config.get<string>('NIUBIZ_CHANNEL') ?? 'web';
    const baseUrl = this.requireConfig('NIUBIZ_SESSION_URL');

    const endpoint = new URL(`${baseUrl}/${merchantId}`);
    endpoint.searchParams.set('amount', String(params.amount));
    endpoint.searchParams.set('purchaseNumber', params.purchaseNumber);
    endpoint.searchParams.set('currency', currency);
    endpoint.searchParams.set('channel', channel);

    const body = {
      channel,
      amount: params.amount,
      antifraud: {
        clientIp: params.clientIp ?? '127.0.0.1',
        merchantDefineData: {
          MDD4: params.userEmail ?? '',  // email del comprador
          MDD32: '1',
          MDD75: 'Ecommerce',
          MDD77: '1',
        },
      },
    };

    const res = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`[Niubiz] createSession ${res.status}: ${text}`);
      throw new InternalServerErrorException(
        'Niubiz: error al crear la sesión de pago',
      );
    }

    const data = (await res.json()) as { sessionKey: string };
    return { sessionKey: data.sessionKey, raw: data };
  }

  // ─── Autorizar pago ────────────────────────────────────────────────────────

  /**
   * Autoriza el cargo con el transactionToken generado por el widget JS.
   * Devuelve la respuesta cruda de Niubiz (data_map con actionCode, etc.).
   *
   * Códigos de éxito en data_map.ACTION_CODE: "000"
   * Cualquier otro código indica rechazo.
   */
  async authorize(params: NiubizAuthorizeParams): Promise<unknown> {
    const token = await this.getSecurityToken();

    const merchantId = this.requireConfig('NIUBIZ_MERCHANT_ID');
    const currency =
      params.currency ?? this.config.get<string>('NIUBIZ_CURRENCY') ?? 'PEN';
    const channel = this.config.get<string>('NIUBIZ_CHANNEL') ?? 'web';
    const baseUrl = this.requireConfig('NIUBIZ_AUTHORIZATION_URL');

    const body = {
      channel,
      captureType: 'manual',
      countable: true,
      order: {
        tokenId: params.transactionToken,
        purchaseNumber: params.purchaseNumber,
        amount: params.amount,
        currency,
      },
    };

    const res = await fetch(`${baseUrl}/${merchantId}`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`[Niubiz] authorize ${res.status}: ${text}`);
      throw new InternalServerErrorException(
        'Niubiz: error en la autorización del pago',
      );
    }

    return res.json();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new InternalServerErrorException(
        `Niubiz: variable de entorno faltante: ${key}`,
      );
    }
    return value;
  }
}
