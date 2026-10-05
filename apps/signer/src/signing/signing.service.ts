import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { Message, walletDeriveSchema } from '../../../../packages/queue/src/messages.js';
import { isEvmChain } from '../../../../packages/shared/src/contracts.js';
import { SigningCore } from './signing.core.js';

@Injectable()
export class SigningService implements OnApplicationShutdown {
  constructor(private readonly core: SigningCore) {}
  execute(action: Message): Message {
    let result: Message;
    if (action.type === 'wallet.derive') {
      action = walletDeriveSchema.parse(action);
      const { type: _type, ...binding } = action;
      try {
        this.core.validateDerivation(action.domainId, action.network, action.path, action.request);
        const derived = this.core.derive(action.request);
        if (derived.path !== action.path) throw new Error('Unexpected derivation path');
        result = {
          ...binding,
          type: 'wallet.derived',
          address: isEvmChain(action.request.chain)
            ? derived.address.toLowerCase()
            : derived.address,
          path: derived.path,
        };
      } catch {
        result = { ...binding, type: 'wallet.rejected' };
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
