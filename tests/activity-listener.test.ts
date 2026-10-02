import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message as PubSubMessage } from '@google-cloud/pubsub';
import { Queue } from 'bullmq';
import { ChainRpcService } from '../packages/chain/src/chain-rpc.service.js';
import { MessageAuth } from '../packages/queue/src/messages.js';
import { ActivityListenerConfig } from '../apps/activity-listener/src/config/activity-listener.config.js';
import { ActivityWorkflowService } from '../apps/activity-listener/src/activity-workflow.service.js';
import { ActivityPubSubService } from '../apps/activity-listener/src/activity-pubsub.service.js';
import { ProcessorActivity } from '../packages/shared/src/activity-contracts.js';

function activity(): ProcessorActivity {
  return {
    identifier: 'transaction:ethereum:0xabc',
    completedAtTimestamp: 1000,
    metadata: { nonce: 2 },
    status: 'success',
    transfers: [
      {
        from: 'wallet:ethereum:0x' + '11'.repeat(20),
        to: 'wallet:ethereum:0x' + '22'.repeat(20),
        amount: '100',
        token: 'token:ethereum:native',
      },
    ],
    tokenIdentifiers: ['token:ethereum:native'],
    fee: { amount: 5, feePayer: ['wallet:ethereum:0x' + '11'.repeat(20)] },
    balanceChanges: [
      {
        wallet: 'wallet:ethereum:0x' + '11'.repeat(20),
        changes: [{ token: 'token:ethereum:native', amount: '-105' }],
      },
      {
        wallet: 'wallet:ethereum:0x' + '22'.repeat(20),
        changes: [{ token: 'token:ethereum:native', amount: '100' }],
      },
    ],
  };
}

function workflow(
  observations: {
    state: 'observed' | 'finalized' | 'failed';
    blockHash?: string;
    blockHeight?: string;
    feeAmount?: string;
  }[],
  network = '11155111',
  failNextObservation = false,
) {
  const ledgerJobs: { name: string; data: unknown; options: { jobId: string } }[] = [];
  const activityJobs: { name: string; data: unknown; options: { jobId: string; delay: number } }[] =
    [];
  const ledger = {
    add: async (name: string, data: unknown, options: { jobId: string }) =>
      ledgerJobs.push({ name, data, options }),
  } as unknown as Queue;
  const activityQueue = {
    add: async (name: string, data: unknown, options: { jobId: string; delay: number }) =>
      activityJobs.push({ name, data, options }),
  } as unknown as Queue;
  const rpc = {
    networkIdentity: () => network,
    observeTransaction: async () => {
      if (failNextObservation) {
        failNextObservation = false;
        throw new Error('RPC unavailable');
      }
      return observations.shift()!;
    },
  } as unknown as ChainRpcService;
  const auth = new MessageAuth('c'.repeat(64));
  const config: ActivityListenerConfig = {
    pubsubProjectId: 'test',
    pubsubSubscription: 'test-subscription',
    pubsubApiEndpoint: undefined,
    finalityPollMs: 30000,
    finalityMaxPolls: 3,
  };
  return {
    service: new ActivityWorkflowService(rpc, auth, activityQueue, ledger, config),
    ledgerJobs,
    activityJobs,
    auth,
  };
}

test('activity listener emits provisional then finalized ledger updates', async () => {
  const state = workflow([
    { state: 'observed', blockHash: '0xblock', blockHeight: '10' },
    { state: 'finalized', blockHash: '0xblock', blockHeight: '10' },
  ]);
  const source = activity();
  await state.service.receive(source, 'pubsub-1');
  assert.equal(state.ledgerJobs.length, 1);
  const provisional = state.auth.open(
    state.ledgerJobs[0].data,
    state.ledgerJobs[0].options.jobId,
    state.ledgerJobs[0].name,
  );
  assert.equal(provisional.type, 'ledger.activity.update');
  if (provisional.type === 'ledger.activity.update') {
    assert.equal(provisional.activity.state, 'observed');
    assert.equal(provisional.activity.changes[0].amount, '-105');
  }
  assert.equal(state.activityJobs[0].options.delay, 30000);
  await state.service.resumeFinality(source, 1, '0xblock');
  const finalized = state.auth.open(
    state.ledgerJobs[1].data,
    state.ledgerJobs[1].options.jobId,
    state.ledgerJobs[1].name,
  );
  assert.equal(finalized.type, 'ledger.activity.update');
  if (finalized.type === 'ledger.activity.update')
    assert.equal(finalized.activity.state, 'finalized');
});

test('failed EVM transactions post the network fee but not reverted transfers', async () => {
  const state = workflow([
    { state: 'failed', blockHash: '0xblock', blockHeight: '10', feeAmount: '5' },
  ]);
  await state.service.receive(activity(), 'pubsub-2');
  const failed = state.auth.open(
    state.ledgerJobs[0].data,
    state.ledgerJobs[0].options.jobId,
    state.ledgerJobs[0].name,
  );
  assert.equal(failed.type, 'ledger.activity.update');
  if (failed.type === 'ledger.activity.update') {
    assert.equal(failed.activity.state, 'failed');
    assert.deepEqual(failed.activity.changes, [
      {
        wallet: 'wallet:ethereum:0x' + '11'.repeat(20),
        asset: 'token:ethereum:native',
        amount: '-5',
      },
    ]);
  }
});

test('failed Solana transactions use Helius fee data and omit reverted transfers', async () => {
  const state = workflow([{ state: 'failed', blockHash: 'block-hash', blockHeight: '20' }]);
  const source = activity();
  source.identifier = 'transaction:solana:signature';
  source.fee = { amount: 5000, feePayer: ['wallet:solana:FeePayer111111111111111111111111111'] };
  source.balanceChanges = [
    {
      wallet: 'wallet:solana:FeePayer111111111111111111111111111',
      changes: [
        { token: 'token:solana:native', amount: '-6000' },
        { token: 'token:solana:Mint111111111111111111111111111111111', amount: '-1000' },
      ],
    },
  ];
  await state.service.receive(source, 'pubsub-solana');
  const failed = state.auth.open(
    state.ledgerJobs[0].data,
    state.ledgerJobs[0].options.jobId,
    state.ledgerJobs[0].name,
  );
  assert.equal(failed.type, 'ledger.activity.update');
  if (failed.type === 'ledger.activity.update') {
    assert.equal(failed.activity.state, 'failed');
    assert.deepEqual(failed.activity.changes, [
      {
        wallet: 'wallet:solana:FeePayer111111111111111111111111111',
        asset: 'token:solana:native',
        amount: '-5000',
      },
    ]);
  }
});

test('listener BSC identifiers map to Wallet Core smartChain ledger assets', async () => {
  const state = workflow([{ state: 'finalized', blockHash: '0xblock', blockHeight: '10' }], '56');
  const source = activity();
  source.identifier = 'transaction:bsc:0xabc';
  source.balanceChanges = [
    {
      wallet: 'wallet:bsc:0x' + '11'.repeat(20),
      changes: [{ token: 'token:bsc:native', amount: '-100' }],
    },
  ];

  await state.service.receive(source, 'pubsub-bsc');
  const posted = state.auth.open(
    state.ledgerJobs[0].data,
    state.ledgerJobs[0].options.jobId,
    state.ledgerJobs[0].name,
  );
  assert.equal(posted.type, 'ledger.activity.update');
  if (posted.type === 'ledger.activity.update') {
    assert.equal(posted.activity.chain, 'smartChain');
    assert.equal(posted.activity.network, '56');
    assert.equal(posted.activity.changes[0].wallet, 'wallet:bsc:0x' + '11'.repeat(20));
    assert.equal(posted.activity.changes[0].asset, 'token:smartChain:native');
  }
});

test('exhausted RPC retries publish attention without dropping provisional changes', async () => {
  const state = workflow([], '11155111', true);
  await state.service.receive(activity(), 'pubsub-offline', true);
  assert.equal(state.ledgerJobs.length, 1);
  const attention = state.auth.open(
    state.ledgerJobs[0].data,
    state.ledgerJobs[0].options.jobId,
    state.ledgerJobs[0].name,
  );
  assert.equal(attention.type, 'ledger.activity.update');
  if (attention.type === 'ledger.activity.update') {
    assert.equal(attention.activity.state, 'attention');
    assert.equal(attention.activity.changes[0].amount, '-105');
  }
});

test('invalid Pub/Sub payloads are durably quarantined before acknowledgement', async () => {
  const auth = new MessageAuth('d'.repeat(64));
  const jobs: { name: string; data: unknown; jobId: string }[] = [];
  const queue = {
    add: async (name: string, data: unknown, options: { jobId: string }) =>
      jobs.push({ name, data, jobId: options.jobId }),
  } as unknown as Queue;
  const config: ActivityListenerConfig = {
    pubsubProjectId: 'test',
    pubsubSubscription: 'test-subscription',
    pubsubApiEndpoint: undefined,
    finalityPollMs: 30000,
    finalityMaxPolls: 3,
  };
  const service = new ActivityPubSubService(config, auth, queue);
  let acknowledgements = 0;
  let negativeAcknowledgements = 0;
  const message = {
    id: 'invalid-pubsub-message',
    data: Buffer.from('{bad json'),
    ack: () => acknowledgements++,
    nack: () => negativeAcknowledgements++,
  } as unknown as PubSubMessage;
  await (service as unknown as { forward(message: PubSubMessage): Promise<void> }).forward(message);
  assert.equal(acknowledgements, 1);
  assert.equal(negativeAcknowledgements, 0);
  assert.equal(jobs.length, 1);
  const invalid = auth.open(jobs[0].data, jobs[0].jobId, jobs[0].name);
  assert.equal(invalid.type, 'activity.invalid');
});
