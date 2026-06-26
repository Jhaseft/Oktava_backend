import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class BusinessHourDto {
  /** 0=Domingo .. 6=Sábado (convención JS getDay). */
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @IsBoolean()
  isClosed: boolean;

  @Matches(HHMM, { message: 'openTime debe tener formato HH:mm' })
  openTime: string;

  @Matches(HHMM, { message: 'closeTime debe tener formato HH:mm' })
  closeTime: string;
}

export class UpdateHoursDto {
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => BusinessHourDto)
  days: BusinessHourDto[];
}
