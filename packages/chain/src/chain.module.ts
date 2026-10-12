import { Module } from '@nestjs/common';
import { ChainRpcService } from './chain-rpc.service.js';
import { TokenPlanner } from './token-planner.js';
import { TokenObserver } from './token-observer.js';
@Module({
  providers: [ChainRpcService, TokenPlanner, TokenObserver],
  exports: [ChainRpcService, TokenPlanner, TokenObserver],
})
export class ChainModule {}
