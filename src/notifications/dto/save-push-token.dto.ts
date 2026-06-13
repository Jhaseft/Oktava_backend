import { IsString, Matches } from 'class-validator';

export class SavePushTokenDto {
  /** Token de Expo, formato ExponentPushToken[xxxxxxxx] o ExpoPushToken[xxxx]. */
  @IsString()
  @Matches(/^Expo(nent)?PushToken\[.+\]$/, {
    message: 'token no tiene un formato de Expo push token válido',
  })
  token!: string;
}
