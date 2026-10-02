import { PubSub } from '@google-cloud/pubsub';

async function setup() {
  const projectId = process.env.PUBSUB_PROJECT_ID ?? 'wallet-local';
  const topicName = process.env.PUBSUB_TOPIC ?? 'on-chain-activity';
  const subscriptionName = process.env.PUBSUB_SUBSCRIPTION ?? 'wallet-activity';
  const apiEndpoint = process.env.PUBSUB_API_ENDPOINT ?? '127.0.0.1:8086';
  const pubsub = new PubSub({ projectId, apiEndpoint });
  try {
    const topic = pubsub.topic(topicName);
    const [topicExists] = await topic.exists();
    if (!topicExists) await topic.create();
    const subscription = topic.subscription(subscriptionName);
    const [subscriptionExists] = await subscription.exists();
    if (!subscriptionExists) await topic.createSubscription(subscriptionName);
    console.log(`Ready: ${projectId}/${topicName} -> ${subscriptionName}`);
  } finally {
    await pubsub.close();
  }
}

setup().catch((error) => {
  console.error('Pub/Sub setup failed; start the emulator and check its configuration');
  console.error(error instanceof Error ? error.message : 'Pub/Sub setup failed');
  process.exitCode = 1;
});
