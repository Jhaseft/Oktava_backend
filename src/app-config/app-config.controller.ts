import { Controller, Get } from '@nestjs/common';
import { AppConfigService } from './app-config.service';
import type { VersionConfig } from './app-config.service';

@Controller('app')
export class AppConfigController {
  constructor(private readonly appConfigService: AppConfigService) {}

  /** GET /app/version — público; consumido por el guard de versiones del cliente. */
  @Get('version')
  getVersion(): VersionConfig {
    return this.appConfigService.getVersionConfig();
  }
}
