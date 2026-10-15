import { Module } from '@nestjs/common';
import { ChainRpcService } from './chain-rpc.service.js';
import { TokenPlanner } from './token-planner.js';
import { TokenObserver } from './token-observer.js';
import { BitcoinBatchPlanner } from './bitcoin-batch-planner.js';
@Module({
  providers: [ChainRpcService, TokenPlanner, TokenObserver, BitcoinBatchPlanner],
  exports: [ChainRpcService, TokenPlanner, TokenObserver, BitcoinBatchPlanner],
})
export class ChainModule {}
