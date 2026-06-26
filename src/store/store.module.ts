import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';

// PrismaService se provee globalmente vía PrismaModule en AppModule.
// Exporta StoreService para que OrdersModule pueda validar el horario.
@Module({
  controllers: [StoreController],
  providers: [StoreService],
  exports: [StoreService],
})
export class StoreModule {}
