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
import { createAggregatorStateStore } from '../lib/aggregatorStateStore';

const kafka = createKafka('aggregator-service');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'aggregator-service-group');
const store = createAggregatorStateStore('.state/aggregator');

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
await publishSchemasOnce(producer);
await startSchemaRegistryConsumer(kafka, 'aggregator-schema-registry');
const consumer = await consumerPromise;

await consumer.subscribe({
   topic: topics.conversationEvents,
   fromBeginning: true,
});

const getState = async (conversationId: string) => {
   try {
      return await store.get(conversationId);
   } catch (error) {
      if ((error as { notFound?: boolean }).notFound) {
         return { userInput: '', toolResults: [], synthesisRequested: false };
      }
      throw error;
   }
};

await runConsumerWithRestart(
   consumer,
   async ({ message }) => {
      if (!message.value) return;
      let event: unknown;
      try {
         event = JSON.parse(message.value.toString());
      } catch (error) {
         await producer.send({
            topic: topics.deadLetterQueue,
            messages: [
               {
                  value: JSON.stringify({
                     error: `Invalid JSON payload: ${(error as Error).message}`,
                     payload: message.value.toString(),
                  }),
               },
            ],
         });
         return;
      }
      if (!(event && typeof event === 'object' && 'eventType' in event)) return;
      const eventRecord = event as {
         eventType: string;
         conversationId: string;
         userId: string;
         payload: Record<string, unknown>;
      };

      if (eventRecord.eventType === 'UserQueryReceived') {
         const state = await getState(eventRecord.conversationId);
         state.userInput = String(eventRecord.payload.userInput ?? '');
         state.synthesisRequested = false;
         await store.put(eventRecord.conversationId, state);
         return;
      }

      if (eventRecord.eventType === 'ToolInvocationResulted') {
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
         const state = await getState(eventRecord.conversationId);
         const stepIndex = Number(eventRecord.payload.stepIndex);
         state.toolResults[stepIndex] = eventRecord.payload.result;
         await store.put(eventRecord.conversationId, state);
         return;
      }

      if (eventRecord.eventType === 'PlanCompleted') {
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
         const state = await getState(eventRecord.conversationId);
         if (state.synthesisRequested) return;
         const command = {
            conversationId: eventRecord.conversationId,
            userId: eventRecord.userId,
            timestamp: new Date().toISOString(),
            commandType: 'SynthesizeFinalAnswerRequested',
            payload: {
               userInput: state.userInput,
               toolResults: state.toolResults,
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
            topic: topics.userCommands,
            messages: [
               {
                  key: eventRecord.conversationId,
                  value: JSON.stringify(command),
               },
            ],
         });
         state.synthesisRequested = true;
         await store.put(eventRecord.conversationId, state);
      }
   },
   'aggregator-service'
);
