import { Body, Controller, Get, Post } from '@nestjs/common';
import { TestService } from './test.service';
import { CreatetaskDto } from './dto/create-task.dto';
 
@Controller('test')
export class TestController {
  constructor(private testService: TestService){}

  @Get()
  async getTest() {
    return await this.testService.getTestService();
  }

  @Post()
  async createTest(@Body() test: CreatetaskDto) {
    return await this.testService.createTestServices(test);
  }
}
