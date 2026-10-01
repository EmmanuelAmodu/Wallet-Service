import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error';
import { Message } from '../../../../packages/queue/src/messages';
import { SigningCore } from './signing.core';

@Injectable()
export class SigningService implements OnApplicationShutdown {
  constructor(private readonly core: SigningCore) {}
  execute(action: Message): Message {
    let result: Message;
    if (action.type === 'wallet.derive') {
      try {
        const derived = this.core.derive(action.request);
        result = {
          type: 'wallet.derived',
          walletId: action.walletId,
          address: derived.address,
          path: derived.path,
        };
      } catch {
        result = { type: 'wallet.rejected', walletId: action.walletId };
      }
    } else if (action.type === 'transaction.sign') {
      try {
        result = {
          type: 'transaction.signed',
          transactionId: action.transactionId,
          signed: this.core.sign(action.request),
        };
      } catch {
        result = { type: 'transaction.rejected', transactionId: action.transactionId };
      }
    } else throw new ActionRejectedError('Unsupported signer action');
    return result;
  }
  onApplicationShutdown() {
    this.core.close();
  }
}
