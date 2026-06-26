import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StoreService } from './store.service';
import { UpdateHoursDto } from './dto/update-hours.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@Controller('store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  /** GET /store/status — público; consumido por la app móvil y web. */
  @Get('status')
  getStatus() {
    return this.storeService.getStatus();
  }

  /** GET /store/hours — público; horario semanal mostrado al cliente y en admin. */
  @Get('hours')
  getHours() {
    return this.storeService.getHours();
  }

  // ─── Admin ───────────────────────────────────────────────────────────────

  /** PATCH /store/hours — guarda el horario de los 7 días. */
  @Patch('hours')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateHours(@Body() dto: UpdateHoursDto) {
    return this.storeService.updateHours(dto);
  }

  /** GET /store/settings — estado de pausa manual. */
  @Get('settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  getSettings() {
    return this.storeService.getSettings();
  }

  /** PATCH /store/settings — pausar/reanudar pedidos manualmente. */
  @Patch('settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.storeService.setSettings(dto);
  }
}
