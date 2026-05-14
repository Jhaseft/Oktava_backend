import { IsEmail, IsString, Matches, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsEmail({}, { message: 'Ingresa un correo electrónico válido.' })
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'El código debe ser de 6 dígitos numéricos.' })
  code: string;

  @IsString()
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres.' })
  newPassword: string;
}
