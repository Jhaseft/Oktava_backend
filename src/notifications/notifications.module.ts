import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

// PrismaService se provee globalmente vía PrismaModule en AppModule.
// Exporta NotificationsService para disparar push desde otros módulos
// (ej. OrdersModule cuando cambie el estado de un pedido).
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
