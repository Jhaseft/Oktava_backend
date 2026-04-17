import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AddressesService } from './addresses.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

interface JwtUser { userId: string; }

@Controller('addresses')
@UseGuards(JwtAuthGuard)
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  @Get()
  findAll(@CurrentUser() user: JwtUser) {
    return this.addressesService.findAll(user.userId);
  }

  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateAddressDto) {
    return this.addressesService.create(user.userId, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateAddressDto) {
    return this.addressesService.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.addressesService.remove(user.userId, id);
  }
}
