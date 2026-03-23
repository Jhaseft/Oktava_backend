import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
    @IsEmail({},{message: 'Mail invalido'})
    email: string;
    @IsString({message: 'La contraseña debe ser un string'})
    @MinLength(6,{message: 'La contraseña debe tener al menos 6 caracteres'})
    password: string;
}