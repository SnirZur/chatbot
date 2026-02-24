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

const kafka = createKafka('synthesis-worker');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'synthesis-worker-group');

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
   topic: topics.userCommands,
   fromBeginning: true,
});

await runConsumerWithRestart(
   consumer,
   async ({ message }) => {
      if (!message.value) return;
      const command = JSON.parse(message.value.toString());
      if (command?.commandType !== 'SynthesizeFinalAnswerRequested') {
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

      const synthesisPayload = JSON.stringify(
         {
            user_request: payload.userInput,
            tool_results: payload.toolResults,
         },
         null,
         2
      );

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
   },
   'synthesis-worker'
);
