import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { BusinessHourDto, UpdateHoursDto } from './dto/update-hours.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

const BOL_OFFSET_MS = 4 * 60 * 60 * 1000; // Bolivia es UTC-4
const SETTINGS_ID = 1;

const DAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

/** Defaults de horario para las 7 filas (Lun-Vie-Sáb 09:00-22:00, domingo abierto también). */
function defaultDay(dayOfWeek: number): BusinessHourDto {
  return { dayOfWeek, isClosed: false, openTime: '09:00', closeTime: '22:00' };
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
}

export type StoreStatus = {
  isOpen: boolean;
  paused: boolean;
  message: string;
  today: {
    dayOfWeek: number;
    isClosed: boolean;
    openTime: string;
    closeTime: string;
  };
};

@Injectable()
export class StoreService {
  constructor(private readonly prisma: PrismaService) {}

  /** Día (0-6) y minutos desde medianoche en hora de Bolivia (UTC-4). */
  private nowBolivia(): { dayOfWeek: number; minutes: number } {
    const nowBOL = new Date(Date.now() - BOL_OFFSET_MS);
    return {
      dayOfWeek: nowBOL.getUTCDay(),
      minutes: nowBOL.getUTCHours() * 60 + nowBOL.getUTCMinutes(),
    };
  }

  /**
   * Encuentra la próxima apertura a partir del día/hora actual.
   * Hoy solo cuenta si aún no pasó la hora de apertura; si ya pasó (dejamos
   * de atender hoy), busca el siguiente día abierto.
   */
  private findNextOpen(
    hours: { dayOfWeek: number; isClosed: boolean; openTime: string }[],
    dayOfWeek: number,
    minutes: number,
  ): { label: string; openTime: string } | null {
    for (let offset = 0; offset < 7; offset++) {
      const d = (dayOfWeek + offset) % 7;
      const day = hours.find((h) => h.dayOfWeek === d);
      if (!day || day.isClosed) continue;
      // Si es hoy pero ya pasó la hora de apertura, hoy no cuenta.
      if (offset === 0 && minutes >= hhmmToMinutes(day.openTime)) continue;

      let label: string;
      if (offset === 0) label = 'Hoy';
      else if (offset === 1) label = 'Mañana';
      else label = `El ${DAY_NAMES[d]}`;
      return { label, openTime: day.openTime };
    }
    return null;
  }

  /** Crea (si faltan) las 7 filas de horario y la fila singleton de settings. */
  private async ensureInitialized(): Promise<void> {
    const count = await this.prisma.businessHour.count();
    if (count < 7) {
      for (let d = 0; d < 7; d++) {
        await this.prisma.businessHour.upsert({
          where: { dayOfWeek: d },
          update: {},
          create: defaultDay(d),
        });
      }
    }
    await this.prisma.storeSettings.upsert({
      where: { id: SETTINGS_ID },
      update: {},
      create: { id: SETTINGS_ID },
    });
  }

  async getHours() {
    await this.ensureInitialized();
    return this.prisma.businessHour.findMany({ orderBy: { dayOfWeek: 'asc' } });
  }

  async updateHours(dto: UpdateHoursDto) {
    await this.ensureInitialized();
    await this.prisma.$transaction(
      dto.days.map((d) =>
        this.prisma.businessHour.upsert({
          where: { dayOfWeek: d.dayOfWeek },
          update: { isClosed: d.isClosed, openTime: d.openTime, closeTime: d.closeTime },
          create: {
            dayOfWeek: d.dayOfWeek,
            isClosed: d.isClosed,
            openTime: d.openTime,
            closeTime: d.closeTime,
          },
        }),
      ),
    );
    return this.getHours();
  }

  async getSettings() {
    await this.ensureInitialized();
    return this.prisma.storeSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID } });
  }

  async setSettings(dto: UpdateSettingsDto) {
    await this.ensureInitialized();
    return this.prisma.storeSettings.update({
      where: { id: SETTINGS_ID },
      data: { ordersPaused: dto.ordersPaused, pauseMessage: dto.pauseMessage ?? null },
    });
  }

  async getStatus(): Promise<StoreStatus> {
    await this.ensureInitialized();
    const [hours, settings] = await Promise.all([
      this.prisma.businessHour.findMany(),
      this.prisma.storeSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID } }),
    ]);

    const { dayOfWeek, minutes } = this.nowBolivia();
    const today =
      hours.find((h) => h.dayOfWeek === dayOfWeek) ?? defaultDay(dayOfWeek);

    const todayInfo = {
      dayOfWeek,
      isClosed: today.isClosed,
      openTime: today.openTime,
      closeTime: today.closeTime,
    };

    // Pausa manual: cierra sin importar el horario.
    if (settings.ordersPaused) {
      return {
        isOpen: false,
        paused: true,
        message: settings.pauseMessage || 'Pedidos pausados temporalmente.',
        today: todayInfo,
      };
    }

    // ¿Está abierto ahora mismo?
    let isOpen = false;
    if (!today.isClosed) {
      const open = hhmmToMinutes(today.openTime);
      const close = hhmmToMinutes(today.closeTime);
      // Si close <= open se interpreta como cruce de medianoche.
      isOpen =
        close > open
          ? minutes >= open && minutes < close
          : minutes >= open || minutes < close;
    }

    if (isOpen) {
      return { isOpen: true, paused: false, message: 'Estamos abiertos.', today: todayInfo };
    }

    // Cerrado: apuntar a la próxima apertura real (hoy antes de abrir, mañana,
    // o el siguiente día abierto).
    const next = this.findNextOpen(hours, dayOfWeek, minutes);
    const message = next
      ? `Estamos cerrados. ${next.label} abrimos a las ${next.openTime}.`
      : 'Estamos cerrados temporalmente.';

    return { isOpen: false, paused: false, message, today: todayInfo };
  }

  /** Lanza STORE_CLOSED si la tienda no está abierta. Usado al crear pedidos. */
  async assertOpen(): Promise<void> {
    const status = await this.getStatus();
    if (!status.isOpen) {
      throw new HttpException(
        { code: 'STORE_CLOSED', message: status.message },
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
