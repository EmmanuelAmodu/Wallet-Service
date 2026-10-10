import { Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';
import { ActionRejectedError } from '../../../../packages/shared/src/action-rejected.error.js';
import { Message, walletDeriveSchema } from '../../../../packages/queue/src/messages.js';
import { isEvmChain } from '../../../../packages/shared/src/contracts.js';
import { SigningCore } from './signing.core.js';
import { CustodySigningPolicy } from './custody-signing.policy.js';
import { custodySignSchema } from '../../../../packages/shared/src/execution-contracts.js';
import {
  executionDigest,
  signSignerAttestation,
} from '../../../../packages/shared/src/execution-authorization.js';

@Injectable()
export class SigningService implements OnApplicationShutdown {
  constructor(
    private readonly core: SigningCore,
    @Optional() private readonly custodyPolicy?: CustodySigningPolicy,
  ) {}

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
      if (this.custodyPolicy)
        throw new ActionRejectedError(
          'Legacy signing is disabled for custody deployments; independent execution authorization required',
        );
      try {
        result = {
          type: 'transaction.signed',
          transactionId: action.transactionId,
          signed: this.core.sign(action.request),
        };
      } catch {
        result = { type: 'transaction.rejected', transactionId: action.transactionId };
      }
    } else if (action.type === 'transaction.custody.sign') {
      const command = custodySignSchema.parse(action);
      const policy = this.custodyPolicy;
      if (!policy?.settings.enabled || !policy.settings.attestationPrivateKey)
        throw new ActionRejectedError('Native sweep execution is disabled');
      const binding = {
        transactionId: command.transactionId,
        operationId: command.operationId,
        attemptId: command.attemptId,
        requestDigest: command.requestDigest,
        preparationDigest: command.preparationDigest,
      };
      let unsigned:
        | Omit<Extract<Message, { type: 'transaction.custody.signed' }>, 'signerAttestation'>
        | Omit<Extract<Message, { type: 'transaction.custody.rejected' }>, 'signerAttestation'>;
      try {
        policy.authorize(command);
        unsigned = {
          ...binding,
          type: 'transaction.custody.signed',
          signed: this.core.sign(command.request),
        };
      } catch {
        unsigned = {
          ...binding,
          type: 'transaction.custody.rejected',
          reason: 'Custody signing policy rejected',
        };
      }
      const status = unsigned.type === 'transaction.custody.signed' ? 'signed' : 'rejected';
      result = {
        ...unsigned,
        signerAttestation: signSignerAttestation(
          {
            version: 1,
            domainId: policy.settings.domainId,
            resetEpoch: policy.settings.resetEpoch,
            ...binding,
            status,
            resultDigest: executionDigest(unsigned),
          },
          policy.settings.attestationPrivateKey,
        ),
      } as Message;
    } else throw new ActionRejectedError('Unsupported signer action');
    return result;
  }

  onApplicationShutdown() {
    this.core.close();
  }
}
