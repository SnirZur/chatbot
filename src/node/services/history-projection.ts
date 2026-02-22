import path from 'node:path';
import {
   createKafka,
   createProducer,
   createConsumer,
   ensureTopics,
   runConsumerWithRestart,
   waitForKafka,
} from '../lib/kafka';
import { topics } from '../lib/topics';
import { schemaPaths, validateOrThrow } from '../lib/schema';
import {
   publishSchemasOnce,
   startSchemaRegistryConsumer,
} from '../lib/schemaRegistry';

const kafka = createKafka('history-projection');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'history-projection-group');

const historyFilePath = path.resolve('history.json');
const historyMap = new Map<
   string,
   Array<{ role: 'user' | 'assistant'; content: string }>
>();

const loadHistory = async () => {
   const file = Bun.file(historyFilePath);
   if (!(await file.exists())) return;
   const data = await file.text();
   const parsed = JSON.parse(data) as Record<
      string,
      Array<{ role: 'user' | 'assistant'; content: string }>
   >;
   if (parsed && typeof parsed === 'object') {
      for (const [userId, history] of Object.entries(parsed)) {
         if (Array.isArray(history)) historyMap.set(userId, history);
      }
   }
};

const saveHistory = async () => {
   const obj: Record<
      string,
      Array<{ role: 'user' | 'assistant'; content: string }>
   > = {};
   for (const [userId, history] of historyMap.entries()) {
      obj[userId] = history;
   }
   await Bun.write(historyFilePath, JSON.stringify(obj, null, 2));
};

await loadHistory();
await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
await publishSchemasOnce(producer);
await startSchemaRegistryConsumer(kafka, 'history-schema-registry');
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
      if (!event || !event.eventType) return;

      if (event.eventType === 'UserQueryReceived') {
         try {
            validateOrThrow(schemaPaths.userQueryEvent, event);
         } catch (error) {
            await producer.send({
               topic: topics.deadLetterQueue,
               messages: [
                  {
                     value: JSON.stringify({
                        error: (error as Error).message,
                        payload: event,
                     }),
                  },
               ],
            });
            return;
         }
         const history = historyMap.get(event.userId) ?? [];
         history.push({ role: 'user', content: event.payload.userInput });
         historyMap.set(event.userId, history);
         await saveHistory();
         return;
      }

      if (event.eventType === 'FinalAnswerSynthesized') {
         try {
            validateOrThrow(schemaPaths.finalAnswerSynthesized, event);
         } catch (error) {
            await producer.send({
               topic: topics.deadLetterQueue,
               messages: [
                  {
                     value: JSON.stringify({
                        error: (error as Error).message,
                        payload: event,
                     }),
                  },
               ],
            });
            return;
         }
         const history = historyMap.get(event.userId) ?? [];
         history.push({ role: 'assistant', content: event.payload.message });
         historyMap.set(event.userId, history);
         await saveHistory();
         return;
      }

      if (event.eventType === 'UserHistoryReset') {
         try {
            validateOrThrow(schemaPaths.userHistoryReset, event);
         } catch (error) {
            await producer.send({
               topic: topics.deadLetterQueue,
               messages: [
                  {
                     value: JSON.stringify({
                        error: (error as Error).message,
                        payload: event,
                     }),
                  },
               ],
            });
            return;
         }
         historyMap.delete(event.userId);
         await saveHistory();
         return;
      }
   },
   'history-projection'
);
