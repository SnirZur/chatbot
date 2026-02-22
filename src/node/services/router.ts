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
import { chatWithOllama, generateWithOpenAI } from '../lib/llm';
import {
   publishSchemasOnce,
   startSchemaRegistryConsumer,
} from '../lib/schemaRegistry';

const kafka = createKafka('router-service');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'router-service-group');

const routerPrompt = fs.readFileSync(
   path.resolve('prompts/router.txt'),
   'utf-8'
);

const parsePlan = (text: string) => {
   const match = text.match(/\{[\s\S]*\}/);
   const candidate = match ? match[0] : text;
   return JSON.parse(candidate);
};

const isValidPlan = (value: unknown) => {
   if (!value || typeof value !== 'object') return false;
   const plan = (value as { plan?: unknown }).plan;
   const synth = (value as { final_answer_synthesis_required?: unknown })
      .final_answer_synthesis_required;
   return Array.isArray(plan) && typeof synth === 'boolean';
};

const sendToDlq = async (payload: unknown, error: string) => {
   const producer = await producerPromise;
   await producer.send({
      topic: topics.deadLetterQueue,
      messages: [{ value: JSON.stringify({ error, payload }) }],
   });
};

const processed = new Set<string>();

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
await publishSchemasOnce(producer);
await startSchemaRegistryConsumer(kafka, 'router-service-schema-registry');
const consumer = await consumerPromise;

await consumer.subscribe({ topic: topics.userCommands, fromBeginning: true });

await runConsumerWithRestart(
   consumer,
   async ({ message }) => {
      try {
         if (!message.value) return;
         const command = JSON.parse(message.value.toString());
         const commandType = command.commandType as string | undefined;
         const incomingConversationId = String(command.conversationId ?? '');
         if (incomingConversationId) {
            const key = `${commandType ?? 'unknown'}:${incomingConversationId}`;
            if (processed.has(key)) return;
            processed.add(key);
         }
         if (commandType === 'UserControl') {
            try {
               validateOrThrow(schemaPaths.userControl, command);
            } catch (error) {
               await sendToDlq(command, (error as Error).message);
               return;
            }
            const { conversationId, userId, timestamp, payload } = command as {
               conversationId: string;
               userId: string;
               timestamp: string;
               payload: { command: string };
            };
            await sendEvent(
               producer,
               schemaPaths.userHistoryReset,
               conversationId,
               {
                  conversationId,
                  userId,
                  timestamp,
                  eventType: 'UserHistoryReset',
                  payload: { command: payload.command },
               }
            );
            return;
         }

         try {
            validateOrThrow(schemaPaths.userQueryReceived, command);
         } catch (error) {
            await sendToDlq(command, (error as Error).message);
            return;
         }

         const { conversationId, userId, timestamp, payload } = command as {
            conversationId: string;
            userId: string;
            timestamp: string;
            payload: { userInput: string };
         };

         await sendEvent(producer, schemaPaths.userQueryEvent, conversationId, {
            conversationId,
            userId,
            timestamp,
            eventType: 'UserQueryReceived',
            payload: { userInput: payload.userInput },
         });

         let planJson: unknown;
         try {
            const ollamaText = await chatWithOllama({
               model: 'llama3',
               system: routerPrompt,
               user: payload.userInput,
            });
            planJson = parsePlan(ollamaText);
            if (!isValidPlan(planJson)) {
               throw new Error('Invalid plan from ollama');
            }
         } catch {
            const fallbackText = await generateWithOpenAI({
               model: 'gpt-3.5-turbo',
               instructions: routerPrompt,
               prompt: payload.userInput,
               maxTokens: 240,
               temperature: 0,
            });
            planJson = parsePlan(fallbackText);
         }

         try {
            await sendEvent(
               producer,
               schemaPaths.planGenerated,
               conversationId,
               {
                  conversationId,
                  userId,
                  timestamp: new Date().toISOString(),
                  eventType: 'PlanGenerated',
                  payload: planJson,
               }
            );
         } catch (error) {
            await sendToDlq(planJson, (error as Error).message);
         }
      } catch (error) {
         console.error('router-service failed:', error);
      }
   },
   'router-service'
);
