import { Module } from '@nestjs/common';
import { ChainRpcService } from './chain-rpc.service';
@Module({ providers: [ChainRpcService], exports: [ChainRpcService] })
export class ChainModule {}
