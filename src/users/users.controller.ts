import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * GET /users?search=maria
   * Returns all CUSTOMER-role users with computed stats (totalOrders, totalSpent, segment).
   */
  @Get()
  findAll(@Query() query: QueryUsersDto) {
    return this.usersService.findAllClients(query);
  }

  /**
   * GET /users/:id
   * Returns a single client with detailed stats and recent orders.
   */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOneClient(id);
  }

  /**
   * PATCH /users/:id
   * Updates editable client fields: firstName, lastName, phone, isActive.
   */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: AdminUpdateUserDto) {
    return this.usersService.updateClient(id, dto);
  }

  /**
   * DELETE /users/:id
   * Soft-deletes the client by setting isActive = false.
   */
  @Delete(':id')
  deactivate(@Param('id') id: string) {
    return this.usersService.deactivateClient(id);
  }
}
