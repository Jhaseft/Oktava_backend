import { Injectable, ConflictException } from '@nestjs/common';
import { LoginDto } from './dto/login.dto';
import { UsersService } from 'src/users/users.service';
import * as bcrypt from 'bcrypt';
import type { User } from '@prisma/client';
import {JwtService} from '@nestjs/jwt';
import { CreateUserDto } from 'src/users/dto/create-user.dto';

@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService, private readonly jwtService: JwtService) {}
  async validateUser({email, password}:LoginDto): Promise<Omit<User,'password'>|null> {
    const user = await this.usersService.findOneByEmail(email);
    if (user && user.password && (await bcrypt.compare(password, user.password))) {
      const {password: _,...result}= user;
      return result;
    }
    return null;
  }

  login(user: Omit<User,'password'>) {
    return this.generateTokenResponse(user);
  }


  async register(user: CreateUserDto ) {
    const existingUser = await this.usersService.findOneByEmail(user.email);
    if(existingUser){
      throw new ConflictException('User with this email already exists');
    }
    const hashedPassword = await bcrypt.hash(user.password, 10);
    const newUser = {
      ...user,
      password: hashedPassword,
    }
    const createdUser = await this.usersService.create(newUser);
    return this.generateTokenResponse(createdUser);
  }


  private generateTokenResponse(user: Omit<User,'password'>) {
    this.usersService.updateLastLogin(user.id);

    const payload ={
      sub: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
    }
    const {createdAt, updatedAt, lastLogin ,...newUser}= user;

    return {
      accessToken: this.jwtService.sign(payload),
      user: newUser
    }
  }
}
