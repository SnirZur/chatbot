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
import { sendEvent } from '../lib/producer';
import {
   publishSchemasOnce,
   startSchemaRegistryConsumer,
} from '../lib/schemaRegistry';
import { createAggregatorStateStore } from '../lib/aggregatorStateStore';

const kafka = createKafka('aggregator-service');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'aggregator-service-group');
const store = createAggregatorStateStore('.state/aggregator');

type ConversationEventRecord = {
   eventType: string;
   conversationId: string;
   userId: string;
   timestamp: string;
   payload: Record<string, unknown>;
};

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

const writeDlq = async (error: string, payload: unknown) => {
   await producer.send({
      topic: topics.deadLetterQueue,
      messages: [{ value: JSON.stringify({ error, payload }) }],
   });
};

const applyEventToState = async (eventRecord: ConversationEventRecord) => {
   const state = await getState(eventRecord.conversationId);

   if (eventRecord.eventType === 'UserQueryReceived') {
      state.userInput = String(eventRecord.payload.userInput ?? '');
      state.synthesisRequested = false;
      await store.put(eventRecord.conversationId, state);
      return state;
   }

   if (eventRecord.eventType === 'ToolInvocationResulted') {
      const stepIndex = Number(eventRecord.payload.stepIndex);
      if (Number.isInteger(stepIndex) && stepIndex >= 0) {
         state.toolResults[stepIndex] = eventRecord.payload.result;
         await store.put(eventRecord.conversationId, state);
      }
      return state;
   }

   if (eventRecord.eventType === 'FinalAnswerSynthesisRequested') {
      state.userInput = String(
         eventRecord.payload.userInput ?? state.userInput
      );
      state.toolResults = Array.isArray(eventRecord.payload.toolResults)
         ? [...(eventRecord.payload.toolResults as unknown[])]
         : state.toolResults;
      state.synthesisRequested = true;
      await store.put(eventRecord.conversationId, state);
      return state;
   }

   return state;
};

const handleEvent = async (event: unknown) => {
   if (!(event && typeof event === 'object' && 'eventType' in event)) return;
   const eventRecord = event as ConversationEventRecord;

   if (eventRecord.eventType === 'UserQueryReceived') {
      try {
         validateOrThrow(schemaPaths.userQueryEvent, event);
      } catch (error) {
         await writeDlq((error as Error).message, event);
         return;
      }
      await applyEventToState(eventRecord);
      return;
   }

   if (eventRecord.eventType === 'ToolInvocationResulted') {
      try {
         validateOrThrow(schemaPaths.toolInvocationResulted, event);
      } catch (error) {
         await writeDlq((error as Error).message, event);
         return;
      }
      await applyEventToState(eventRecord);
      return;
   }

   if (eventRecord.eventType === 'FinalAnswerSynthesisRequested') {
      try {
         validateOrThrow(schemaPaths.finalAnswerSynthesisRequestedEvent, event);
      } catch (error) {
         await writeDlq((error as Error).message, event);
         return;
      }
      await applyEventToState(eventRecord);
      return;
   }

   if (eventRecord.eventType !== 'PlanCompleted') return;

   try {
      validateOrThrow(schemaPaths.planCompleted, event);
   } catch (error) {
      await writeDlq((error as Error).message, event);
      return;
   }

   const state = await getState(eventRecord.conversationId);
   const shouldSynthesize = Boolean(
      eventRecord.payload.final_answer_synthesis_required
   );
   if (!shouldSynthesize || state.synthesisRequested) return;

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
      validateOrThrow(schemaPaths.synthesizeFinalAnswerRequested, command);
   } catch (error) {
      await writeDlq((error as Error).message, command);
      return;
   }

   await producer.send({
      topic: topics.finalSynthesisRequests,
      messages: [
         {
            key: eventRecord.conversationId,
            value: JSON.stringify(command),
         },
      ],
   });

   await sendEvent(
      producer,
      schemaPaths.finalAnswerSynthesisRequestedEvent,
      eventRecord.conversationId,
      {
         conversationId: eventRecord.conversationId,
         userId: eventRecord.userId,
         timestamp: new Date().toISOString(),
         eventType: 'FinalAnswerSynthesisRequested',
         payload: {
            userInput: state.userInput,
            toolResults: state.toolResults,
         },
      }
   );

   state.synthesisRequested = true;
   await store.put(eventRecord.conversationId, state);
};

const replayConversationEvents = async () => {
   const admin = kafka.admin();
   await admin.connect();
   let lastOffset = '0';
   try {
      const offsets = await admin.fetchTopicOffsets(topics.conversationEvents);
      lastOffset = offsets[0]?.offset ?? '0';
   } finally {
      await admin.disconnect();
   }

   await store.clear();

   if (Number(lastOffset) === 0) return;

   const replayConsumer = await createConsumer(
      kafka,
      `aggregator-replay-${Date.now()}`
   );
   await replayConsumer.subscribe({
      topic: topics.conversationEvents,
      fromBeginning: true,
   });

   await new Promise<void>((resolve, reject) => {
      let resolved = false;
      void replayConsumer
         .run({
            autoCommit: false,
            eachMessage: async ({ message, heartbeat }) => {
               if (!message.value) return;
               let event: unknown;
               try {
                  event = JSON.parse(message.value.toString());
               } catch {
                  return;
               }
               await handleEvent(event);
               await heartbeat();
               if (
                  Number(message.offset) >= Number(lastOffset) - 1 &&
                  !resolved
               ) {
                  resolved = true;
                  resolve();
               }
            },
         })
         .catch((error) => {
            if (!resolved) reject(error);
         });
   });

   await replayConsumer.stop();
   await replayConsumer.disconnect();
};

await replayConversationEvents();

await runConsumerWithRestart(
   consumer,
   async ({ message }) => {
      if (!message.value) return;
      let event: unknown;
      try {
         event = JSON.parse(message.value.toString());
      } catch (error) {
         await writeDlq(
            `Invalid JSON payload: ${(error as Error).message}`,
            message.value.toString()
         );
         return;
      }
      await handleEvent(event);
   },
   'aggregator-service'
);
