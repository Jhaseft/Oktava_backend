import { IsOptional, IsString } from 'class-validator';

export class QueryUsersDto {
  /**
   * Full-text search over firstName, lastName, email and phone.
   * Example: GET /users?search=maria
   */
  @IsOptional()
  @IsString()
  search?: string;
}
