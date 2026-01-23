import { createKafka, parseMessage } from './kafka';
import { AppResultEvent, topics } from './types';

const kafka = createKafka('response-aggregator');
const consumer = kafka.consumer({ groupId: 'response-aggregator-group' });
const producer = kafka.producer();

await producer.connect();
await consumer.connect();
await consumer.subscribe({ topic: topics.appResults, fromBeginning: true });

consumer.run({
   eachMessage: async ({ message }) => {
      const parsed = parseMessage<AppResultEvent>(message);
      if (!parsed) return;

      const payload = { message: parsed.value.result };
      await producer.send({
         topic: topics.botResponses,
         messages: [{ key: parsed.key, value: JSON.stringify(payload) }],
      });
   },
});
