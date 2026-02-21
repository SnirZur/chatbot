import {
   createKafka,
   createConsumer,
   ensureTopics,
   runConsumerWithRestart,
   waitForKafka,
} from '../lib/kafka';
import { topics } from '../lib/topics';

const kafka = createKafka('metrics-service');
const consumerPromise = createConsumer(kafka, 'metrics-service-group');

const timelines = new Map<string, Record<string, string>>();
const invocationStarts = new Map<string, { tool: string; timestamp: string }>();
let eventCount = 0;
let startWindow = Date.now();

await waitForKafka(kafka);
await ensureTopics(kafka);

const consumer = await consumerPromise;
await consumer.subscribe({
   topic: topics.conversationEvents,
   fromBeginning: true,
});

await runConsumerWithRestart(
   consumer,
   async ({ message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString());
      if (!event?.conversationId || !event?.eventType || !event?.timestamp)
         return;

      const timeline = timelines.get(event.conversationId) ?? {};
      timeline[event.eventType] = event.timestamp;
      timelines.set(event.conversationId, timeline);

      eventCount += 1;
      const now = Date.now();
      if (now - startWindow >= 10000) {
         const throughput = eventCount / ((now - startWindow) / 1000);
         console.log(
            `[METRICS] throughput=${throughput.toFixed(2)} events/sec`
         );
         eventCount = 0;
         startWindow = now;
      }

      if (event.eventType === 'FinalAnswerSynthesized') {
         const start = timeline['UserQueryReceived'];
         if (start) {
            const endToEnd =
               new Date(event.timestamp).getTime() - new Date(start).getTime();
            console.log(
               `[METRICS] conversation=${event.conversationId} end_to_end_ms=${endToEnd}`
            );
         }
      }

      if (event.eventType === 'ToolInvocationRequested') {
         const { invocationId, tool } = event.payload ?? {};
         if (invocationId) {
            invocationStarts.set(invocationId, {
               tool,
               timestamp: event.timestamp,
            });
         }
      }

      if (event.eventType === 'ToolInvocationResulted') {
         const { invocationId } = event.payload ?? {};
         if (invocationId && invocationStarts.has(invocationId)) {
            const start = invocationStarts.get(invocationId)!;
            const latency =
               new Date(event.timestamp).getTime() -
               new Date(start.timestamp).getTime();
            console.log(
               `[METRICS] tool=${start.tool} invocation=${invocationId} latency_ms=${latency}`
            );
            invocationStarts.delete(invocationId);
         }
      }
   },
   'metrics-service'
);

const admin = kafka.admin();
setInterval(async () => {
   try {
      await admin.connect();
      const topicOffsets = await admin.fetchTopicOffsets(
         topics.conversationEvents
      );
      const groupOffsets = await admin.fetchOffsets({
         groupId: 'metrics-service-group',
         topics: [topics.conversationEvents],
      });
      const lag = topicOffsets.reduce((sum, topicOffset) => {
         const groupTopic = groupOffsets.find(
            (group) => group.topic === topicOffset.topic
         );
         if (!groupTopic) return sum;
         const partitions = topicOffset.partitions;
         return (
            sum +
            partitions.reduce((acc, partition) => {
               const groupPartition = groupTopic.partitions.find(
                  (p) => p.partition === partition.partition
               );
               if (!groupPartition) return acc;
               return (
                  acc +
                  Math.max(
                     0,
                     Number(partition.offset) - Number(groupPartition.offset)
                  )
               );
            }, 0)
         );
      }, 0);
      console.log(`[METRICS] consumer_lag=${lag}`);
   } catch (error) {
      console.warn('[METRICS] lag check failed', error);
   } finally {
      await admin.disconnect().catch(() => undefined);
   }
}, 15000);
