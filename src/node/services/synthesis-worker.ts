import fs from 'node:fs';
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
import { sendEvent } from '../lib/producer';
import { generateWithOpenAI } from '../lib/llm';
import {
   publishSchemasOnce,
   startSchemaRegistryConsumer,
} from '../lib/schemaRegistry';
import {
   createIdempotencyStore,
   hasBeenProcessed,
   markProcessed,
} from '../lib/idempotencyStore';

const kafka = createKafka('synthesis-worker');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'synthesis-worker-group');
const idempotencyStore = createIdempotencyStore('.state/idempotency/synthesis');

const synthesisPrompt = fs.readFileSync(
   path.resolve('prompts/orchestration-synthesis.txt'),
   'utf-8'
);

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
await publishSchemasOnce(producer);
await startSchemaRegistryConsumer(kafka, 'synthesis-schema-registry');
const consumer = await consumerPromise;

await consumer.subscribe({
   topic: topics.finalSynthesisRequests,
   fromBeginning: true,
});

await runConsumerWithRestart(
   consumer,
   async ({ message }) => {
      if (!message.value) return;
      let command: unknown;
      try {
         command = JSON.parse(message.value.toString());
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
      const commandType = (command as { commandType?: string }).commandType;
      if (commandType !== 'SynthesizeFinalAnswerRequested') {
         return;
      }
      try {
         validateOrThrow(schemaPaths.synthesizeFinalAnswerRequested, command);
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

      const { conversationId, userId, payload } = command as {
         conversationId: string;
         userId: string;
         payload: { userInput: string; toolResults: unknown[] };
      };
      if (await hasBeenProcessed(idempotencyStore, conversationId)) {
         return;
      }

      const synthesisPayload = JSON.stringify(
         {
            user_request: payload.userInput,
            tool_results: payload.toolResults,
         },
         null,
         2
      );

      try {
         const text = await generateWithOpenAI({
            model: 'gpt-3.5-turbo',
            instructions: synthesisPrompt,
            prompt: synthesisPayload,
            maxTokens: 200,
            temperature: 0.2,
         });

         await sendEvent(
            producer,
            schemaPaths.finalAnswerSynthesized,
            conversationId,
            {
               conversationId,
               userId,
               timestamp: new Date().toISOString(),
               eventType: 'FinalAnswerSynthesized',
               payload: { message: text },
            }
         );
         await markProcessed(idempotencyStore, conversationId);
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
      }
   },
   'synthesis-worker'
);
