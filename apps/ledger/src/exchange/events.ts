import { randomUUID } from 'node:crypto';
import type { ExchangeEvent } from '../../../../packages/queue/src/exchange-contracts.js';

export function resultIdentity(source: ExchangeEvent, revision = source.revision) {
  return {
    eventId: randomUUID(),
    schemaVersion: 1 as const,
    resetEpoch: source.resetEpoch,
    occurredAt: new Date().toISOString(),
    domainId: source.domainId,
    correlationId: source.correlationId,
    causationId: source.eventId,
    aggregateId: source.aggregateId,
    revision,
    ...(source.customerId ? { customerId: source.customerId } : {}),
    ...(source.operationId ? { operationId: source.operationId } : {}),
    ...(source.attemptId ? { attemptId: source.attemptId } : {}),
    ...(source.requestDigest ? { requestDigest: source.requestDigest } : {}),
    ...(source.policyVersion ? { policyVersion: source.policyVersion } : {}),
  };
}
