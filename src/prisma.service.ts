import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private static pool: Pool;
  private readonly logger = new Logger(PrismaService.name);

  constructor(private configService: ConfigService) {
    const connectionString = configService.get<string>('DATABASE_URL');

    if (!connectionString) {
      throw new Error('DATABASE_URL no está configurada');
    }

    // Singleton pool: prevents multiple pools on hot-reload
    if (!PrismaService.pool) {
      PrismaService.pool = new Pool({
        connectionString,
        max: 10,
        // Close idle connections after 20s — shorter than most NAT/firewall timeouts
        // so we never hand a dead connection to Prisma
        idleTimeoutMillis: 20000,
        connectionTimeoutMillis: 10000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });

      PrismaService.pool.on('error', (err) => {
        // Log but don't crash — pg-pool removes the dead client automatically
        new Logger('PrismaPool').warn(`Idle client error (safe to ignore): ${err.message}`);
      });
    }

    const adapter = new PrismaPg(PrismaService.pool);
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await PrismaService.pool?.end();
  }
}
