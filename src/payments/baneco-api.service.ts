import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'node:https';
import * as http from 'node:http';
import { URL } from 'node:url';

const BANECO_TIMEOUT_MS = 12_000;
const DEFAULT_TOKEN_TTL_MS = 14 * 60 * 1_000;
const TOKEN_EXPIRY_SKEW_MS = 45 * 1_000;

interface RawResponse {
  status: number;
  body: string;
  contentType: string;
}

/**
 * Petición HTTP cruda (sin axios) hacia la API de Banco Económico. Devuelve el
 * body como texto y el content-type normalizado para poder detectar respuestas
 * no-JSON (proveedor caído / HTML de error).
 */
function rawRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;

    const opts: https.RequestOptions = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: {
        ...headers,
        ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
      },
    };

    const req = lib.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        const rawCt = res.headers['content-type'] ?? '';
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: rawCt.split(';')[0].trim().toLowerCase(),
        });
      });
    });

    req.setTimeout(BANECO_TIMEOUT_MS, () => {
      req.destroy(new Error(`Baneco timeout after ${BANECO_TIMEOUT_MS}ms`));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface GenerateQrParams {
  transactionId: string;
  amount: number;
  currency?: 'BOB' | 'USD';
  description?: string;
  dueDate: string;
  singleUse?: boolean;
  modifyAmount?: boolean;
  reqId?: string;
}

export interface GenerateQrResponse {
  qrId: string;
  qrImage: string;
}

/** Objeto PaymentQR devuelto por el banco al confirmar un pago. */
export interface PaymentQR {
  qrId: string;
  transactionId: string;
  paymentDate: string;
  paymentTime: string;
  currency: string;
  amount: number;
  senderBankCode?: string;
  senderName?: string;
  senderDocumentId?: string;
  senderAccount?: string;
  description?: string;
}

export interface StatusQrResponse {
  // 0: activo pendiente de pago | 1: pagado | 9: anulado
  statusQrCode: 0 | 1 | 9;
  // En v2 el banco devuelve payment como arreglo (uno o más pagos).
  payment?: PaymentQR | PaymentQR[];
}

interface TokenContext {
  token: string;
  source: 'cached' | 'new';
}

/**
 * Cliente HTTP puro para la API "Pago Simple con QR" de Banco Económico.
 * No depende de Prisma ni del dominio de Oktava: solo habla con el banco.
 *
 * Flujo interno para cualquier operación autenticada:
 *   1. encrypt()      → cifra la contraseña / número de cuenta con AES-256
 *   2. login()        → obtiene el Bearer token (cacheado en memoria)
 *   3. authedCall()   → llama al endpoint con el token, reintenta 1 vez si 401
 */
@Injectable()
export class BanecoApiService {
  private readonly logger = new Logger(BanecoApiService.name);

  private readonly base: string;
  private readonly aesKey: string;
  private readonly username: string;
  private readonly password: string;
  private readonly accountCredit: string;
  private readonly currency: 'BOB' | 'USD';

  private token: string | null = null;
  private tokenLoadedAt = 0;
  private tokenExpiresAt = 0;
  private loginInFlight: Promise<TokenContext> | null = null;

  constructor(private readonly config: ConfigService) {
    this.base = this.readNormalizedEnv('BANECO_API_BASE');
    this.aesKey = this.readNormalizedEnv('BANECO_AES_KEY');
    this.username = this.readNormalizedEnv('BANECO_USERNAME');
    this.password = this.readNormalizedEnv('BANECO_PASSWORD');
    this.accountCredit = this.readNormalizedEnv('BANECO_ACCOUNT_CREDIT');
    const rawCurrency = this.readNormalizedEnv('BANECO_CURRENCY').toUpperCase();
    this.currency = rawCurrency === 'USD' ? 'USD' : 'BOB';
  }

  private newReqId() {
    return Math.random().toString(36).slice(2, 9);
  }

  // Las credenciales del banco suelen venir con comillas o saltos de línea al
  // pegarlas en el .env; se normalizan para evitar fallos silenciosos de auth.
  private readNormalizedEnv(key: string): string {
    const raw = this.config.get<string>(key) ?? '';
    const trimmed = raw.trim();
    const quoteWrapped =
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"));
    const withoutQuotes =
      quoteWrapped && trimmed.length >= 2 ? trimmed.slice(1, -1).trim() : trimmed;
    return withoutQuotes.replace(/[\r\n]+/g, '');
  }

  private ensureConfig() {
    if (!this.base || !this.aesKey || !this.username || !this.password || !this.accountCredit) {
      this.logger.error(
        `[QR][config] Config incompleta base=${!!this.base} aesKey=${!!this.aesKey} user=${!!this.username} pass=${!!this.password} account=${!!this.accountCredit}`,
      );
      throw new ServiceUnavailableException('Baneco QR no está configurado.');
    }
  }

  // ─── Encriptación AES ──────────────────────────────────────────────────────

  async encrypt(text: string): Promise<string> {
    this.ensureConfig();
    const url =
      `${this.base}/api/authentication/encrypt` +
      `?text=${encodeURIComponent(text)}&aesKey=${encodeURIComponent(this.aesKey)}`;

    let res: RawResponse;
    try {
      res = await rawRequest(url, 'GET', {});
    } catch (err: any) {
      this.logger.error(`[QR][encrypt] networkError=${err?.message ?? err}`);
      throw new ServiceUnavailableException('Baneco encrypt: error de red.');
    }

    if (res.status < 200 || res.status >= 300) {
      this.logger.error(`[QR][encrypt] HTTP ${res.status}`);
      throw new ServiceUnavailableException('Baneco encrypt falló.');
    }
    return res.body.trim().replace(/^"|"$/g, '');
  }

  // ─── Token ─────────────────────────────────────────────────────────────────

  private getTokenExpiryFromLogin(data: any): number | null {
    const now = Date.now();
    const absoluteCandidates = [
      data?.expiresAt,
      data?.expireAt,
      data?.expirationDate,
      data?.tokenExpiration,
    ];
    for (const value of absoluteCandidates) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const ms = Date.parse(value);
      if (Number.isFinite(ms) && ms > now) return ms;
    }
    const ttlCandidates = [data?.expiresIn, data?.expireIn, data?.expiresInSeconds];
    for (const value of ttlCandidates) {
      const ttl = Number(value);
      if (Number.isFinite(ttl) && ttl > 0) return now + ttl * 1_000;
    }
    return null;
  }

  private invalidateToken(reqId: string, reason: string) {
    this.token = null;
    this.tokenLoadedAt = 0;
    this.tokenExpiresAt = 0;
    this.logger.warn(`[QR][${reqId}] Baneco token invalidated reason=${reason}`);
  }

  private async login(reqId: string): Promise<TokenContext> {
    this.ensureConfig();
    const authPath = '/api/authentication/authenticate';

    const encPass = await this.encrypt(this.password);
    const url = `${this.base}${authPath}`;
    const body = { userName: this.username, password: encPass };

    let res: RawResponse;
    try {
      res = await rawRequest(
        url,
        'POST',
        { 'Content-Type': 'application/json' },
        JSON.stringify(body),
      );
    } catch (err: any) {
      this.logger.error(`[QR][${reqId}] Baneco auth networkError=${err?.message ?? err}`);
      throw new ServiceUnavailableException('Baneco login: error de red.');
    }

    if (res.status === 401 || res.status === 403) {
      this.logger.error(`[QR][${reqId}] Baneco auth unauthorized status=${res.status}`);
      throw new ServiceUnavailableException({
        message: 'No se pudo generar el QR en este momento. Intenta nuevamente en unos minutos.',
        code: 'QR_PROVIDER_UNAUTHORIZED',
        providerStatus: res.status,
      });
    }

    let data: { responseCode?: number; message?: string; token?: string };
    try {
      data = JSON.parse(res.body);
    } catch {
      this.logger.error(`[QR][${reqId}] Baneco auth invalid JSON response`);
      throw new ServiceUnavailableException('Baneco login: respuesta inválida.');
    }

    if (data.responseCode !== 0 || !data.token) {
      this.logger.error(
        `[QR][${reqId}] Baneco auth failed responseCode=${data.responseCode} message="${data.message ?? 'sin detalle'}"`,
      );
      throw new ServiceUnavailableException(`Baneco login falló: ${data.message ?? 'sin detalle'}`);
    }

    const now = Date.now();
    const expiry = this.getTokenExpiryFromLogin(data);
    this.token = data.token;
    this.tokenLoadedAt = now;
    this.tokenExpiresAt = expiry ?? now + DEFAULT_TOKEN_TTL_MS;
    return { token: data.token, source: 'new' };
  }

  private isTokenValid() {
    if (!this.token) return false;
    return this.tokenExpiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now();
  }

  private async ensureToken(reqId: string): Promise<TokenContext> {
    if (this.isTokenValid()) {
      return { token: this.token!, source: 'cached' };
    }
    // Deduplica logins concurrentes: si ya hay uno en vuelo, esperamos ese.
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.login(reqId).finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  // ─── Llamada autenticada genérica ──────────────────────────────────────────

  private unauthorizedException(reqId: string, path: string, status: number) {
    this.logger.error(`[QR][${reqId}] failed reason=QR_PROVIDER_UNAUTHORIZED path=${path}`);
    return new ServiceUnavailableException({
      message: 'No se pudo generar el QR en este momento. Intenta nuevamente en unos minutos.',
      code: 'QR_PROVIDER_UNAUTHORIZED',
      providerStatus: status,
    });
  }

  private nonJsonException(reqId: string, path: string, status: number) {
    this.logger.error(`[QR][${reqId}] failed reason=NON_JSON_RESPONSE path=${path} status=${status}`);
    return new ServiceUnavailableException({
      message: 'No se pudo generar el QR en este momento. Intenta nuevamente en unos minutos.',
      code: 'QR_PROVIDER_NON_JSON_RESPONSE',
      providerStatus: status,
    });
  }

  private async authedCall<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: Record<string, unknown>,
    opts?: { tolerateError?: boolean; reqId?: string; retryUnauthorizedOnce?: boolean },
  ): Promise<T> {
    this.ensureConfig();

    const reqId = opts?.reqId ?? this.newReqId();
    const retryUnauthorizedOnce = opts?.retryUnauthorizedOnce ?? true;

    let token = await this.ensureToken(reqId);
    const url = `${this.base}${path}`;
    const sendBody = body ? JSON.stringify(body) : undefined;

    const exec = async (
      tokenCtx: TokenContext,
    ): Promise<{ kind: 'success'; data: T; status: number } | { kind: 'unauthorized'; status: number }> => {
      let r: RawResponse;
      try {
        r = await rawRequest(
          url,
          method,
          {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenCtx.token}`,
          },
          sendBody,
        );
      } catch (netErr: any) {
        this.logger.error(`[QR][${reqId}] network/timeout path=${path} err=${netErr?.message ?? netErr}`);
        throw new ServiceUnavailableException(
          'No se pudo generar el QR en este momento. Intenta nuevamente en unos minutos.',
        );
      }

      if (r.status === 401 || r.status === 403) {
        return { kind: 'unauthorized', status: r.status };
      }

      let parsed: any;
      try {
        parsed = JSON.parse(r.body);
      } catch {
        if (opts?.tolerateError) {
          return {
            kind: 'success',
            data: { responseCode: -1, message: 'NON_JSON_RESPONSE' } as T,
            status: r.status,
          };
        }
        throw this.nonJsonException(reqId, path, r.status);
      }

      if (parsed?.responseCode !== 0) {
        const looksLikeAuth =
          parsed?.responseCode === 401 ||
          /token|autentic|credencial|no valid|unauthor/i.test(String(parsed?.message ?? ''));
        if (looksLikeAuth) return { kind: 'unauthorized', status: r.status || 401 };

        if (opts?.tolerateError) return { kind: 'success', data: parsed as T, status: r.status };

        this.logger.error(
          `[QR][${reqId}] failed path=${path} responseCode=${parsed?.responseCode} msg="${parsed?.message ?? 'sin detalle'}"`,
        );
        throw new ServiceUnavailableException(`Baneco ${path} falló: ${parsed?.message ?? 'sin detalle'}`);
      }

      return { kind: 'success', data: parsed as T, status: r.status };
    };

    let result = await exec(token);

    if (result.kind === 'unauthorized') {
      if (!retryUnauthorizedOnce) throw this.unauthorizedException(reqId, path, result.status);

      this.logger.warn(`[QR][${reqId}] ${path} 401, refreshing token and retrying once`);
      this.invalidateToken(reqId, `unauthorized_status_${result.status}`);
      token = await this.ensureToken(reqId);
      result = await exec(token);

      if (result.kind === 'unauthorized') throw this.unauthorizedException(reqId, path, result.status);
    }

    return result.data;
  }

  // ─── Operaciones del banco ─────────────────────────────────────────────────

  /** Genera un QR de cobro. `transactionId` es nuestra referencia (id del Payment). */
  async generateQR(params: GenerateQrParams): Promise<GenerateQrResponse & { responseCode: number }> {
    const reqId = params.reqId ?? this.newReqId();
    const accountEnc = await this.encrypt(this.accountCredit);

    return this.authedCall<GenerateQrResponse & { responseCode: number }>(
      '/api/qrsimple/generateQR',
      'POST',
      {
        transactionId: params.transactionId,
        accountCredit: accountEnc,
        currency: params.currency ?? this.currency,
        amount: Number(params.amount.toFixed(2)),
        description: params.description ?? '',
        dueDate: params.dueDate,
        singleUse: params.singleUse ?? true,
        modifyAmount: params.modifyAmount ?? false,
      },
      { reqId, retryUnauthorizedOnce: true },
    );
  }

  /**
   * Consulta el estado de un QR (endpoint oficial v2, el qrId va en la URL).
   * `payment` puede venir como arreglo; devolvemos el primer pago normalizado.
   */
  async statusQR(qrId: string, reqId?: string): Promise<StatusQrResponse & { responseCode: number }> {
    return this.authedCall<StatusQrResponse & { responseCode: number }>(
      `/api/qrsimple/v2/statusQR/${encodeURIComponent(qrId)}`,
      'GET',
      undefined,
      { reqId },
    );
  }

  /** Anula un QR pendiente (uso único no pagado). Tolera error para leer el mensaje. */
  async cancelQR(qrId: string, reqId?: string): Promise<{ responseCode: number; message?: string }> {
    return this.authedCall<{ responseCode: number; message?: string }>(
      '/api/qrsimple/cancelQR',
      'DELETE',
      { qrId },
      { tolerateError: true, reqId },
    );
  }

  /** Normaliza el campo `payment` de statusQR/webhook (arreglo u objeto) a un solo PaymentQR. */
  static firstPayment(payment?: PaymentQR | PaymentQR[]): PaymentQR | null {
    if (!payment) return null;
    if (Array.isArray(payment)) return payment[0] ?? null;
    return payment;
  }
}
