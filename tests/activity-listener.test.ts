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
import { resolveChainIdentifier } from '../packages/shared/src/contracts.js';

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
    state: 'observed' | 'finalized' | 'failed' | 'reverted';
    transactionFound?: boolean;
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
  let observationSequence = 0n;
  const redis = {
    runCommand: async (_name: string, args: unknown[]) => {
      const baseline = BigInt(String(args[1]));
      observationSequence =
        observationSequence > baseline ? observationSequence + 1n : baseline + 1n;
      return observationSequence.toString();
    },
    defineCommand: () => undefined,
  };
  const ledger = {
    add: async (name: string, data: unknown, options: { jobId: string }) =>
      ledgerJobs.push({ name, data, options }),
    toKey: (key: string) => `test:ledger:${key}`,
    getBackend: () => ({ client: Promise.resolve(redis) }),
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
    reconciliationPollMs: 300000,
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

test('activity listener reverses a previously mined transaction removed from the canonical chain', async () => {
  const state = workflow([
    { state: 'observed', blockHash: '0xold-block', blockHeight: '10' },
    { state: 'observed', transactionFound: false },
  ]);
  const source = activity();
  await state.service.receive(source, 'pubsub-reorg');
  await state.service.resumeFinality(source, 1, '0xold-block');

  const reverted = state.auth.open(
    state.ledgerJobs[1].data,
    state.ledgerJobs[1].options.jobId,
    state.ledgerJobs[1].name,
  );
  assert.equal(reverted.type, 'ledger.activity.update');
  if (reverted.type === 'ledger.activity.update') {
    assert.equal(reverted.activity.state, 'reverted');
    assert.equal(reverted.activity.canonicalReconciliation, true);
    assert.ok(BigInt(reverted.activity.observationSequence!) > 0n);
    assert.deepEqual(reverted.activity.changes, []);
  }
  assert.equal(state.activityJobs.length, 2);
});

test('activity listener keeps a previously mined transaction provisional when it remains in mempool', async () => {
  const state = workflow([{ state: 'observed', transactionFound: true }]);
  await state.service.resumeFinality(activity(), 1, '0xold-block');
  const observed = state.auth.open(
    state.ledgerJobs[0].data,
    state.ledgerJobs[0].options.jobId,
    state.ledgerJobs[0].name,
  );
  assert.equal(observed.type, 'ledger.activity.update');
  if (observed.type === 'ledger.activity.update') {
    assert.equal(observed.activity.state, 'observed');
    assert.equal(observed.activity.canonicalReconciliation, true);
    assert.notDeepEqual(observed.activity.changes, []);
  }
});

test('activity observation ordering follows RPC start order when responses complete out of order', async () => {
  const ledgerJobs: { name: string; data: unknown; options: { jobId: string } }[] = [];
  let sequence = 0n;
  const redis = {
    runCommand: async () => (++sequence).toString(),
    defineCommand: () => undefined,
  };
  const ledgerQueue = {
    add: async (name: string, data: unknown, options: { jobId: string }) =>
      ledgerJobs.push({ name, data, options }),
    toKey: (key: string) => key,
    getBackend: () => ({ client: Promise.resolve(redis) }),
  } as unknown as Queue;
  const activityQueue = { add: async () => undefined } as unknown as Queue;
  const auth = new MessageAuth('c'.repeat(64));
  let resolveOlder!: () => void;
  let markOlderStarted!: () => void;
  const olderStarted = new Promise<void>((resolve) => (markOlderStarted = resolve));
  const olderGate = new Promise<void>((resolve) => (resolveOlder = resolve));
  let observations = 0;
  const rpc = {
    networkIdentity: () => '11155111',
    observeTransaction: async () => {
      observations += 1;
      if (observations === 1) {
        markOlderStarted();
        await olderGate;
        return { state: 'observed' as const, transactionFound: true, blockHash: '0xold' };
      }
      return { state: 'finalized' as const, transactionFound: true, blockHash: '0xnew' };
    },
  } as unknown as ChainRpcService;
  const service = new ActivityWorkflowService(rpc, auth, activityQueue, ledgerQueue, {
    pubsubProjectId: 'test',
    pubsubSubscription: 'test-subscription',
    pubsubApiEndpoint: undefined,
    finalityPollMs: 30000,
    finalityMaxPolls: 3,
    reconciliationPollMs: 300000,
  });
  const source = activity();
  const older = service.receive(source, 'pubsub-older');
  await olderStarted;
  await service.receive(source, 'pubsub-newer');
  resolveOlder();
  await older;

  const published = ledgerJobs.map((job) => auth.open(job.data, job.options.jobId, job.name));
  const newer = published[0];
  const delayedOlder = published[1];
  assert.equal(newer.type, 'ledger.activity.update');
  assert.equal(delayedOlder.type, 'ledger.activity.update');
  if (newer.type === 'ledger.activity.update' && delayedOlder.type === 'ledger.activity.update') {
    const newerSequence = BigInt(newer.activity.observationSequence!);
    const olderSequence = BigInt(delayedOlder.activity.observationSequence!);
    assert.ok(newerSequence > olderSequence);
  }
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

test('listener deduplicates BSC and smartChain aliases using canonical chain, network, and hash', async () => {
  const state = workflow(
    [
      { state: 'finalized', blockHash: '0xblock', blockHeight: '10' },
      { state: 'finalized', blockHash: '0xblock', blockHeight: '10' },
    ],
    '56',
  );
  const bsc = activity();
  bsc.identifier = 'transaction:bsc:0xABC';
  bsc.balanceChanges = [
    {
      wallet: 'wallet:bsc:0x' + '11'.repeat(20),
      changes: [{ token: 'token:bsc:native', amount: '100' }],
    },
  ];
  const canonical = activity();
  canonical.identifier = 'transaction:smartChain:0xabc';
  canonical.balanceChanges = [
    {
      wallet: 'wallet:smartChain:0x' + '11'.repeat(20),
      changes: [{ token: 'token:smartChain:native', amount: '100' }],
    },
  ];

  await state.service.receive(bsc, 'pubsub-bsc-alias');
  await state.service.receive(canonical, 'pubsub-canonical-chain');

  const updates = state.ledgerJobs.map((job) =>
    state.auth.open(job.data, job.options.jobId, job.name),
  );
  assert.equal(updates[0].type, 'ledger.activity.update');
  assert.equal(updates[1].type, 'ledger.activity.update');
  if (
    updates[0].type === 'ledger.activity.update' &&
    updates[1].type === 'ledger.activity.update'
  ) {
    assert.equal(updates[0].activity.identifier, 'transaction:smartChain:56:0xabc');
    assert.equal(updates[1].activity.identifier, updates[0].activity.identifier);
    assert.equal(updates[0].activity.transactionHash, updates[1].activity.transactionHash);
    assert.ok(
      BigInt(updates[1].activity.observationSequence!) >
        BigInt(updates[0].activity.observationSequence!),
    );
  }
});

test('shared chain resolver accepts every canonical chain and the BSC alias', () => {
  assert.equal(resolveChainIdentifier('litecoin'), 'litecoin');
  assert.equal(resolveChainIdentifier('smartChain'), 'smartChain');
  assert.equal(resolveChainIdentifier('bsc'), 'smartChain');
  assert.equal(resolveChainIdentifier('unknown-chain'), undefined);
  assert.equal(resolveChainIdentifier('toString'), undefined);
});

test('exhausted RPC retries publish attention without dropping provisional changes', async () => {
  const state = workflow([], '11155111', true);
  await state.service.receive(activity(), 'pubsub-offline', true);
  assert.equal(state.ledgerJobs.length, 1);
  assert.equal(state.activityJobs.length, 1);
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

test('successful late observations remain provisional while checks use the recovery interval', async () => {
  const state = workflow([{ state: 'observed', blockHash: '0xblock', blockHeight: '10' }]);
  await state.service.resumeFinality(activity(), 3, '0xblock');
  const observation = state.auth.open(
    state.ledgerJobs[0].data,
    state.ledgerJobs[0].options.jobId,
    state.ledgerJobs[0].name,
  );
  assert.equal(observation.type, 'ledger.activity.update');
  if (observation.type === 'ledger.activity.update')
    assert.equal(observation.activity.state, 'observed');
  assert.equal(state.activityJobs[0].options.delay, 300000);
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
    reconciliationPollMs: 300000,
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

test('Solana inclusion without a block hash is reversed on disappearance', async () => {
  const state = workflow([
    { state: 'observed', transactionFound: true, blockHeight: '20' },
    { state: 'observed', transactionFound: false },
  ]);
  const source = activity();
  source.identifier = 'transaction:solana:signature';
  source.balanceChanges = [];
  await state.service.receive(source, 'solana-inclusion');
  const check = state.auth.open(
    state.activityJobs[0].data,
    state.activityJobs[0].options.jobId,
    state.activityJobs[0].name,
  );
  assert.equal(check.type, 'activity.check-finality');
  if (check.type !== 'activity.check-finality') throw new Error('Wrong action');
  assert.equal(check.previouslyIncluded, true);
  assert.equal(check.blockHash, undefined);
  await state.service.resumeFinality(
    check.activity,
    check.poll,
    check.blockHash,
    false,
    check.previouslyIncluded,
  );
  const update = state.auth.open(
    state.ledgerJobs[1].data,
    state.ledgerJobs[1].options.jobId,
    state.ledgerJobs[1].name,
  );
  assert.equal(update.type, 'ledger.activity.update');
  if (update.type !== 'ledger.activity.update') throw new Error('Wrong update');
  assert.equal(update.activity.state, 'reverted');
  assert.equal(update.activity.canonicalReconciliation, true);
  assert.deepEqual(update.activity.changes, []);
});
