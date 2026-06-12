import { Module } from '@nestjs/common';
import { AppConfigController } from './app-config.controller';
import { AppConfigService } from './app-config.service';

// ConfigModule está registrado globalmente en AppModule.
@Module({
  controllers: [AppConfigController],
  providers: [AppConfigService],
})
export class AppConfigModule {}
