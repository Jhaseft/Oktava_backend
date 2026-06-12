import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type VersionConfig = {
  minSupportedVersion: string;
  message?: string;
};

/**
 * Config de versión que consume el guard del cliente móvil.
 * Los valores vienen de variables de entorno para poder forzar una
 * actualización sin necesidad de redeploy del cliente:
 *   APP_MIN_SUPPORTED_VERSION  -> versión mínima (por debajo => update obligatorio)
 *   APP_UPDATE_MESSAGE         -> mensaje opcional para la pantalla de update
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  getVersionConfig(): VersionConfig {
    const minSupportedVersion =
      this.config.get<string>('APP_MIN_SUPPORTED_VERSION') ?? '7.0.0';
    const message = this.config.get<string>('APP_UPDATE_MESSAGE') || undefined;

    return { minSupportedVersion, message };
  }
}
