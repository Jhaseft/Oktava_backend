import { Injectable } from '@nestjs/common';
import { LoginDto } from './dto/login.dto';
import { UsersService } from 'src/users/users.service';
import * as bcrypt from 'bcrypt';
import type { User } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService) {}
  async validateUser({email, password}:LoginDto): Promise<Omit<User,'passwordHash'>|null> {
    const user = await this.usersService.findOneByEmail(email);
    if (user && user.passwordHash && (await bcrypt.compare(password, user.passwordHash))) {
      const {passwordHash: _,...result}= user;
      return result;
    }
    return null;
  }




  private generateTokenResponse(user: Omit<User,'passwordHash'>) {

  }
}
