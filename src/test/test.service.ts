import { Injectable } from '@nestjs/common';
import { CreatetaskDto } from './dto/create-task.dto';
import { PrismaService } from '../prisma.service';

@Injectable()
export class TestService {
  constructor(private prisma: PrismaService) {}

  async getTestService() {
    return await this.prisma.user.findMany();
  }

  async createTestServices(test: CreatetaskDto) {
    await this.prisma.user.create({
      data: test,
    });
    return {
      success: true,
      message: 'Usuario creado correctamente',
    };
  }
}
