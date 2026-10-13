import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ExchangeEvent, exchangeEventSchema, operationMetricSchema } from './exchange-contracts.js';
export type OperationalMetric = z.infer<typeof operationMetricSchema>;
export function operationsMetrics(
  source: Extract<ExchangeEvent, { type: 'operations.repair.requested.v1' }>,
  consumer: 'ledger' | 'sweep' | 'activity-listener' | 'broadcast',
  metrics: OperationalMetric[],
) {
  return exchangeEventSchema.parse({
    ...source,
    eventId: randomUUID(),
    causationId: source.eventId,
    occurredAt: new Date().toISOString(),
    type: 'operations.metrics.reported.v1',
    data: { commandId: source.data.commandId, consumer, metrics },
  });
}
export function ageMetric(
  name: string,
  rows: { created_at: Date }[],
  threshold = 300000,
): OperationalMetric {
  const age = rows.reduce((max, row) => Math.max(max, Date.now() - row.created_at.getTime()), 0);
  return {
    name,
    value: String(Math.max(0, age)),
    labels: {},
    ...(age > threshold
      ? {
          alert: 'warning' as const,
          reason: 'Durable work exceeds the operational recovery threshold',
        }
      : {}),
  };
}
