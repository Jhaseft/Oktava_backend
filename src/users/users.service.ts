import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PrismaService } from 'prisma/prisma.service';
import { User } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prismaService: PrismaService) {}


  async create(createUserDto: CreateUserDto):Promise<User> {
    try{
      return await this.prismaService.user.create({
        data: createUserDto
      });
    }catch(error){
      if(error.code === 'P2002' && error.meta?.target?.includes('email')){
        throw new Error('User with this email already exists');
      }
    }
    throw new InternalServerErrorException('Error al crear el usuario.');

  }

  findAll() {
    return `This action returns all users`;
  }

  async findOneByEmail(email:string): Promise<User|null> {
    return this.prismaService.user.findFirst({
      where: {email:{equals: email, mode: 'insensitive'}}
    })
    
  }

  async updateLastLogin(userId: string):Promise<void>{
    const data = await this.prismaService.user.update({
      where: {id: userId},
      data: {lastLogin: new Date()}
    })
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return `This action updates a #${id} user`;
  }

  remove(id: number) {
    return `This action removes a #${id} user`;
  }
}
