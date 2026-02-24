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

const productPatterns = [
   { name: 'PrintForge Mini', pattern: /printforge\s*-?\s*mini/i },
   { name: 'BrewMaster 360', pattern: /brewmaster\s*-?\s*360/i },
   { name: 'EvoPhone X', pattern: /evophone\s*-?\s*x/i },
   { name: 'Voltrider E2', pattern: /voltrider\s*-?\s*e2/i },
];

const detectProductName = (input: string) => {
   for (const entry of productPatterns) {
      if (entry.pattern.test(input)) return entry.name;
   }
   return null;
};

const ensureRagSteps = (
   planJson: {
      plan: Array<{ tool: string; parameters: Record<string, unknown> }>;
      final_answer_synthesis_required: boolean;
   },
   userInput: string,
   productName: string
) => {
   const plan = planJson.plan;
   const hasTool = (tool: string) => plan.some((step) => step.tool === tool);
   let productStepIndex = plan.findIndex(
      (step) => step.tool === 'getProductInformation'
   );

   if (productStepIndex === -1) {
      plan.push({
         tool: 'getProductInformation',
         parameters: { query: productName },
      });
      productStepIndex = plan.length - 1;
   }

   const ragStepIndex = plan.findIndex((step) => step.tool === 'ragGeneration');
   const ragPayload = `User question: ${userInput}\nKnowledge: <result_from_tool_${productStepIndex + 1}>`;
   if (ragStepIndex === -1) {
      plan.push({
         tool: 'ragGeneration',
         parameters: { ragPayload },
      });
   } else {
      plan[ragStepIndex].parameters = {
         ...plan[ragStepIndex].parameters,
         ragPayload,
      };
   }

   planJson.final_answer_synthesis_required = true;
};

const extractAmount = (input: string, pattern: RegExp) => {
   const match = input.match(pattern);
   if (!match) return null;
   const value = Number(match[1]);
   return Number.isFinite(value) ? value : null;
};

const ensureExchangeAndMath = (
   planJson: {
      plan: Array<{ tool: string; parameters: Record<string, unknown> }>;
      final_answer_synthesis_required: boolean;
   },
   userInput: string
) => {
   const shekel = extractAmount(
      userInput,
      /(\d+(?:\.\d+)?)\s*(?:ש״ח|ש\"ח|שח|₪)/i
   );
   const usd = extractAmount(userInput, /(\d+(?:\.\d+)?)\s*(?:דולר|usd|\$)/i);
   if (shekel === null || usd === null) return;

   const plan = planJson.plan;
   let exchangeIndex = plan.findIndex(
      (step) => step.tool === 'getExchangeRate'
   );
   let mathIndex = plan.findIndex((step) => step.tool === 'calculateMath');

   if (exchangeIndex === -1) {
      const insertAt = mathIndex === -1 ? plan.length : mathIndex;
      plan.splice(insertAt, 0, {
         tool: 'getExchangeRate',
         parameters: { from: 'USD', to: 'ILS' },
      });
      exchangeIndex = insertAt;
      if (mathIndex !== -1) mathIndex += 1;
   }

   const expression = `${shekel} - (${usd} * <result_from_tool_${exchangeIndex + 1}>)`;

   if (mathIndex === -1) {
      plan.push({
         tool: 'calculateMath',
         parameters: { expression },
      });
   } else {
      plan[mathIndex].parameters = {
         ...plan[mathIndex].parameters,
         expression,
      };
   }

   planJson.final_answer_synthesis_required = true;
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
         if (commandType === 'SynthesizeFinalAnswerRequested') {
            return;
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
            if (!isValidPlan(planJson)) {
               throw new Error('Invalid plan from OpenAI fallback');
            }
         }

         try {
            const productName = detectProductName(payload.userInput);
            if (productName) {
               ensureRagSteps(
                  planJson as {
                     plan: Array<{
                        tool: string;
                        parameters: Record<string, unknown>;
                     }>;
                     final_answer_synthesis_required: boolean;
                  },
                  payload.userInput,
                  productName
               );
            }
            ensureExchangeAndMath(
               planJson as {
                  plan: Array<{
                     tool: string;
                     parameters: Record<string, unknown>;
                  }>;
                  final_answer_synthesis_required: boolean;
               },
               payload.userInput
            );
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
