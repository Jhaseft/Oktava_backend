import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAddressDto {
  @IsString()
  label: string;

  @IsString()
  direction: string;

  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsString()
  @IsOptional()
  placeId?: string;

  @IsString()
  @MaxLength(100)
  departament: string;

  @IsString()
  @IsOptional()
  reference?: string;

  @IsString()
  @IsOptional()
  contact?: string;
}
