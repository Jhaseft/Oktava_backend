import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { SavePushTokenDto } from './dto/save-push-token.dto';

interface JwtUser {
  userId: string;
}

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * POST /notifications/token
   * Guarda el Expo push token del usuario autenticado.
   */
  @Post('token')
  async saveToken(
    @CurrentUser() user: JwtUser,
    @Body() dto: SavePushTokenDto,
  ) {
    await this.notificationsService.savePushToken(user.userId, dto.token);
    return { ok: true };
  }

  /**
   * POST /notifications/test
   * Envía una notificación de prueba al usuario autenticado (debug).
   */
  @Post('test')
  async sendTest(@CurrentUser() user: JwtUser) {
    const sent = await this.notificationsService.sendToUser(user.userId, {
      title: 'OKtava',
      body: '🎉 ¡Las notificaciones funcionan!',
      data: { type: 'test' },
    });
    return { sent };
  }
}
