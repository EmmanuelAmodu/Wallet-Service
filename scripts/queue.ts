import { Queue } from 'bullmq';
import { connection } from '../packages/queue/src/messaging.module';
import { QUEUES } from '../packages/queue/src/messages';
import { required } from '../packages/shared/src/config';

async function main() {
  const [action, name, id] = process.argv.slice(2);
  if (!Object.values(QUEUES).some((q) => q === name) || !['failed', 'retry'].includes(action))
    throw new Error(
      'Usage: npm run queue -- failed|retry wallet-actions|signer-actions|broadcast-actions [job-id]',
    );
  const queue = new Queue(name, {
    connection: { ...connection(required('REDIS_URL')), maxRetriesPerRequest: 1 },
    prefix: process.env.QUEUE_PREFIX ?? 'waas',
  });
  try {
    if (action === 'failed') {
      const jobs = await queue.getJobs(['failed'], 0, 99);
      console.log(
        JSON.stringify(
          jobs.map((job) => ({
            id: job.id,
            action: job.name,
            attempts: job.attemptsMade,
            reason: job.failedReason,
          })),
          null,
          2,
        ),
      );
    } else {
      if (!id) throw new Error('A failed job ID is required');
      const job = await queue.getJob(id);
      if (!job || (await job.getState()) !== 'failed') throw new Error('Failed job not found');
      await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
      console.log('Queued retry of existing action; signed bytes are unchanged');
    }
  } finally {
    await queue.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Queue operation failed');
  process.exitCode = 1;
});
