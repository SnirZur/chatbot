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

const kafka = createKafka('aggregator-service');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'aggregator-service-group');

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
const consumer = await consumerPromise;

await consumer.subscribe({
   topic: topics.conversationEvents,
   fromBeginning: true,
});

const toolResults = new Map<string, unknown[]>();
const userInputs = new Map<string, string>();

await runConsumerWithRestart(
   consumer,
   async ({ message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString());
      if (!event || !event.eventType) return;

      if (event.eventType === 'UserQueryReceived') {
         userInputs.set(event.conversationId, event.payload.userInput ?? '');
         return;
      }

      if (event.eventType === 'ToolInvocationResulted') {
         try {
            validateOrThrow(schemaPaths.toolInvocationResulted, event);
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
         const results = toolResults.get(event.conversationId) ?? [];
         results[event.payload.stepIndex] = event.payload.result;
         toolResults.set(event.conversationId, results);
         return;
      }

      if (event.eventType === 'PlanCompleted') {
         try {
            validateOrThrow(schemaPaths.planCompleted, event);
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
         const results = toolResults.get(event.conversationId) ?? [];
         const command = {
            conversationId: event.conversationId,
            userId: event.userId,
            timestamp: new Date().toISOString(),
            commandType: 'SynthesizeFinalAnswerRequested',
            payload: {
               userInput: userInputs.get(event.conversationId) ?? '',
               toolResults: results,
            },
         };
         try {
            validateOrThrow(
               schemaPaths.synthesizeFinalAnswerRequested,
               command
            );
         } catch (error) {
            await producer.send({
               topic: topics.deadLetterQueue,
               messages: [
                  {
                     value: JSON.stringify({
                        error: (error as Error).message,
                        payload: command,
                     }),
                  },
               ],
            });
            return;
         }

         await producer.send({
            topic: topics.synthesisRequests,
            messages: [
               { key: event.conversationId, value: JSON.stringify(command) },
            ],
         });
      }
   },
   'aggregator-service'
);
