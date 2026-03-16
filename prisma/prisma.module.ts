import { Module, Global } from '@nestjs/common'; // Si usas Global, ayuda mucho
import { PrismaService } from './prisma.service';

@Global() // 👈 Recomendado: Hazlo global para no sufrir importándolo en todos lados
@Module({
    providers: [PrismaService],
    exports: [PrismaService], // 👈 ¡ESTO ES OBLIGATORIO!
})
export class PrismaModule { }