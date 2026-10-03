import { Queue } from 'bullmq';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connection } from '../packages/queue/src/messaging.module.js';
import { MessageAuth, QUEUES } from '../packages/queue/src/messages.js';
import { required } from '../packages/shared/src/config.js';

export async function reconcileActivity(queue: Queue, identifier: string, auth: MessageAuth) {
  const jobs = await queue.getJobs(
    ['waiting', 'active', 'delayed', 'failed', 'completed'],
    0,
    9999,
  );
  const candidates = [];
  for (const job of jobs) {
    try {
      const message = auth.open(job.data, job.id!, job.name);
      if (message.type !== 'activity.check-finality' || message.activity.identifier !== identifier)
        continue;
      candidates.push({ job, poll: message.poll, state: await job.getState() });
    } catch {
      continue;
    }
  }
  candidates.sort((left, right) => right.poll - left.poll);
  const candidate = candidates[0];
  if (!candidate) throw new Error('No retained finality check found for this activity');
  if (candidate.state === 'waiting' || candidate.state === 'active')
    return 'Activity reconciliation is already queued or active';
  if (candidate.state === 'delayed') await candidate.job.changeDelay(Date.now());
  else if (candidate.state === 'failed' || candidate.state === 'completed')
    await candidate.job.retry(candidate.state, {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
  else throw new Error(`Finality check cannot be reconciled from state ${candidate.state}`);
  return `Queued finality reconciliation at poll ${candidate.poll}`;
}

async function main() {
  const [action, name, id] = process.argv.slice(2);
  if (
    !Object.values(QUEUES).some((q) => q === name) ||
    !['failed', 'retry', 'reconcile'].includes(action) ||
    (action === 'reconcile' && name !== QUEUES.activity)
  )
    throw new Error(
      'Usage: npm run queue -- failed|retry QUEUE [job-id] | reconcile activity-actions ACTIVITY_IDENTIFIER',
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
    } else if (action === 'retry') {
      if (!id) throw new Error('A failed job ID is required');
      const job = await queue.getJob(id);
      if (!job || (await job.getState()) !== 'failed') throw new Error('Failed job not found');
      await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
      console.log('Queued retry of existing action; signed bytes are unchanged');
    } else {
      if (!id) throw new Error('An activity identifier is required');
      console.log(await reconcileActivity(queue, id, new MessageAuth(required('QUEUE_AUTH_KEY'))));
    }
  } finally {
    await queue.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Queue operation failed');
    process.exitCode = 1;
  });
}
