import { Module } from '@nestjs/common';
import { UserPrismaService } from './prisma.service.js';

@Module({ providers: [UserPrismaService], exports: [UserPrismaService] })
export class UserPrismaModule {}
