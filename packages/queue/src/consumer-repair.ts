import { Queue } from 'bullmq';
import { MessageAuth } from './messages.js';
const cursors = new WeakMap<Queue, number>();
/** Retry existing authenticated jobs only; never reconstruct signing inputs or replace transaction bytes. */
export async function retryFailedConsumerJobs(queue: Queue, auth: MessageAuth, domainId: string) {
  let retried = 0,
    stale = 0;
  const offset = cursors.get(queue) ?? 0;
  const jobs = await queue.getFailed(offset, offset + 99);
  for (const job of jobs) {
    try {
      const message = auth.open(job.data, job.id!, job.name);
      if (!('domainId' in message) || message.domainId !== domainId) {
        stale++;
        continue;
      }
      if ((await job.getState()) !== 'failed') continue;
      await job.retry('failed');
      retried++;
    } catch {
      stale++;
    }
  }
  // Retried jobs leave the failed set; advance only past entries left behind.
  // A stale first page must not permanently starve recoverable deliveries.
  cursors.set(queue, jobs.length < 100 ? 0 : offset + jobs.length - retried);
  return { retried, stale };
}
