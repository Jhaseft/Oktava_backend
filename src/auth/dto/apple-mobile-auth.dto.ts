import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AppleMobileAuthDto {
  @IsString()
  @IsNotEmpty({ message: 'El identityToken de Apple es requerido.' })
  identityToken: string;

  // Apple user id estable (viene siempre). Sirve de fallback si el token no lo trae.
  @IsOptional()
  @IsString()
  appleUserId?: string;

  // Apple solo envía email/nombre en el PRIMER login. Se persisten esa vez.
  @IsOptional()
  @IsEmail({}, { message: 'El email de Apple no es válido.' })
  email?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;
}
