import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export type PushMessage = {
  title: string;
  body: string;
  /** Data extra que llega a la app (ej. { type: 'order', orderId }). */
  data?: Record<string, unknown>;
};

/**
 * Servicio de notificaciones push reutilizable.
 *
 * - `savePushToken`: persiste el Expo push token del usuario.
 * - `sendToUser`: envía un push a un usuario (busca su token guardado).
 * - `sendToTokens`: envía a una lista de tokens (uso interno / masivo).
 *
 * Usa la API HTTP de Expo Push directamente (sin SDK extra). Para producción
 * con Android, recuerda tener las credenciales FCM configuradas en EAS.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Guarda (o actualiza) el push token del usuario. */
  async savePushToken(userId: string, token: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { pushToken: token },
    });
  }

  /** Borra el token del usuario (ej. logout / token inválido). */
  async clearPushToken(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { pushToken: null },
    });
  }

  /**
   * Envía un push a un usuario por su id. No-op si el usuario no tiene token.
   * @returns true si se intentó el envío, false si no había token.
   */
  async sendToUser(userId: string, message: PushMessage): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { pushToken: true },
    });

    if (!user?.pushToken) {
      this.logger.debug(`Usuario ${userId} sin push token; se omite envío.`);
      return false;
    }

    await this.sendToTokens([user.pushToken], message);
    return true;
  }

  /** Envía el mismo mensaje a una lista de tokens de Expo. */
  async sendToTokens(tokens: string[], message: PushMessage): Promise<void> {
    const valid = tokens.filter(Boolean);
    if (valid.length === 0) return;

    const payload = valid.map((to) => ({
      to,
      sound: 'default',
      title: message.title,
      body: message.body,
      data: message.data ?? {},
    }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.error(`Expo push falló (${res.status}): ${text}`);
        return;
      }

      const json = (await res.json().catch(() => null)) as {
        data?: { status: string; message?: string }[];
      } | null;

      // Expo responde por mensaje; logueamos los que fallaron individualmente.
      json?.data?.forEach((ticket, i) => {
        if (ticket.status === 'error') {
          this.logger.warn(
            `Push a ${valid[i]} con error: ${ticket.message ?? 'desconocido'}`,
          );
        }
      });
    } catch (e) {
      this.logger.error('Error de red al enviar push a Expo', e as Error);
    }
  }
}
