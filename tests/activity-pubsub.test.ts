import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Message as PubSubMessage } from '@google-cloud/pubsub';
import { Queue } from 'bullmq';
import { ActivityPubSubService } from '../apps/activity-listener/src/activity-pubsub.service.js';
import { ActivityListenerConfig } from '../apps/activity-listener/src/config/activity-listener.config.js';
import { MessageAuth } from '../packages/queue/src/messages.js';

function activity(resetEpoch?: string) {
  return {
    ...(resetEpoch ? { resetEpoch } : {}),
    identifier: 'transaction:solana:signature',
    completedAtTimestamp: 1,
    metadata: { slot: 1 },
    status: 'success',
    transfers: [],
    tokenIdentifiers: [],
    fee: { amount: 0, feePayer: [] },
    balanceChanges: [],
  };
}

function createMessage(payload: unknown) {
  const calls = { ack: 0, nack: 0 };
  const message = {
    id: 'provider-message-1',
    data: Buffer.from(JSON.stringify(payload)),
    ack: () => calls.ack++,
    nack: () => calls.nack++,
  } as unknown as PubSubMessage;
  return { message, calls };
}

function serviceFor(calls: unknown[]) {
  const config: ActivityListenerConfig = {
    pubsubProjectId: 'wallet-local',
    pubsubSubscription: 'activity-test',
    pubsubApiEndpoint: '127.0.0.1:8086',
    finalityPollMs: 30000,
    finalityMaxPolls: 120,
    reconciliationPollMs: 300000,
  };
  const queue = {
    add: async (...args: unknown[]) => calls.push(args),
  } as unknown as Queue;
  const auth = new MessageAuth('a'.repeat(64), 'epoch-current');
  return new ActivityPubSubService(config, auth, queue);
}

test('Pub/Sub ingress quarantines missing and stale provider epochs before queueing activity', async () => {
  const calls: unknown[] = [];
  const service = serviceFor(calls);

  for (const payload of [activity(), activity('epoch-retired')]) {
    const { message, calls: ackCalls } = createMessage(payload);
    await (service as unknown as { forward(message: PubSubMessage): Promise<void> }).forward(
      message,
    );
    assert.equal(ackCalls.ack, 1);
    assert.equal(ackCalls.nack, 0);
  }

  assert.equal(calls.length, 2);
  for (const call of calls) {
    const [, envelope] = call as [string, unknown];
    const opened = new MessageAuth('a'.repeat(64), 'epoch-current').open(
      envelope,
      (envelope as { id: string }).id,
      'activity.invalid',
    );
    assert.equal(opened.type, 'activity.invalid');
    if (opened.type === 'activity.invalid') assert.match(opened.reason, /epoch/);
  }
});

test('Pub/Sub ingress queues only provider events from the configured reset epoch', async () => {
  const calls: unknown[] = [];
  const service = serviceFor(calls);
  const { message, calls: ackCalls } = createMessage(activity('epoch-current'));

  await (service as unknown as { forward(message: PubSubMessage): Promise<void> }).forward(message);

  assert.equal(ackCalls.ack, 1);
  assert.equal(ackCalls.nack, 0);
  assert.equal(calls.length, 1);
  const [, envelope] = calls[0] as [string, unknown];
  const opened = new MessageAuth('a'.repeat(64), 'epoch-current').open(
    envelope,
    (envelope as { id: string }).id,
    'activity.received',
  );
  assert.equal(opened.type, 'activity.received');
});
