import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MessageAuth } from '../packages/queue/src/messages';

test('queue envelopes reject tampering, wrong job IDs, action substitution and wrong keys', () => {
  const auth = new MessageAuth('a'.repeat(64));
  const message = { type: 'transaction.prepare' as const, transactionId: randomUUID() };
  const envelope = auth.seal(message);
  assert.deepEqual(auth.open(envelope, envelope.id, message.type), message);
  assert.throws(() =>
    auth.open(
      { ...envelope, payload: { ...message, transactionId: randomUUID() } },
      envelope.id,
      message.type,
    ),
  );
  assert.throws(() => auth.open(envelope, randomUUID(), message.type));
  assert.throws(() => auth.open(envelope, envelope.id, 'transaction.sign'));
  assert.throws(() => new MessageAuth('b'.repeat(64)).open(envelope, envelope.id, message.type));
});
