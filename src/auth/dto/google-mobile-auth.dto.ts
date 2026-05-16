import { IsNotEmpty, IsString } from 'class-validator';

export class GoogleMobileAuthDto {
  @IsString()
  @IsNotEmpty({ message: 'El idToken de Google es requerido.' })
  idToken: string;
}
