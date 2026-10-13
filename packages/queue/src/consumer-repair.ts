import { Queue } from 'bullmq';
import { MessageAuth } from './messages.js';
/** Retry existing authenticated jobs only; never reconstruct signing inputs or replace transaction bytes. */
export async function retryFailedConsumerJobs(queue: Queue, auth: MessageAuth, domainId: string) {
  let retried = 0,
    stale = 0;
  for (const job of await queue.getFailed(0, 99)) {
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
  return { retried, stale };
}
