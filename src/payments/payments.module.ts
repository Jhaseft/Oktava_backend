import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { NiubizService } from './niubiz.service';
import { BanecoController } from './baneco.controller';
import { BanecoService } from './baneco.service';
import { BanecoApiService } from './baneco-api.service';

@Module({
  imports: [OrdersModule],
  controllers: [PaymentsController, BanecoController],
  providers: [PaymentsService, NiubizService, BanecoService, BanecoApiService],
  exports: [PaymentsService, BanecoService],
})
export class PaymentsModule {}
