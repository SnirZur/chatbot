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
import {
   createIdempotencyStore,
   hasBeenProcessed,
   markProcessed,
} from '../lib/idempotencyStore';

const kafka = createKafka('router-service');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'router-service-group');
const idempotencyStore = createIdempotencyStore('.state/idempotency/router');

const routerPrompt = fs.readFileSync(
   path.resolve('prompts/router.txt'),
   'utf-8'
);

const parsePlan = (text: string) => {
   const match = text.match(/\{[\s\S]*\}/);
   const candidate = match ? match[0] : text;
   return JSON.parse(candidate);
};

type ToolName =
   | 'calculateMath'
   | 'getExchangeRate'
   | 'getWeather'
   | 'generalChat'
   | 'ragGeneration'
   | 'analyzeReview'
   | 'orchestrationSynthesis'
   | 'getProductInformation';

type PlanStep = { tool: ToolName; parameters: Record<string, unknown> };
type PlanPayload = {
   plan: PlanStep[];
   final_answer_synthesis_required: boolean;
};

const getObject = (value: unknown): Record<string, unknown> | null =>
   value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

const asString = (value: unknown) =>
   typeof value === 'string' ? value.trim() : '';

const normalizePlanPayload = (
   value: unknown,
   userInput: string
): PlanPayload => {
   const root = getObject(value);
   if (!root) throw new Error('Plan root must be an object');
   const planRaw = root.plan;
   if (!Array.isArray(planRaw)) throw new Error('Plan must contain an array');
   const synth = root.final_answer_synthesis_required;
   if (typeof synth !== 'boolean') {
      throw new Error('Plan must include final_answer_synthesis_required');
   }

   const normalizedPlan: PlanStep[] = [];
   for (const rawStep of planRaw) {
      const normalizedStep = (() => {
         const step = getObject(rawStep);
         if (!step) return null;
         const tool = asString(step.tool) as ToolName;
         const parameters = getObject(step.parameters) ?? {};

         switch (tool) {
            case 'calculateMath': {
               const expression = asString(parameters.expression);
               return expression ? { tool, parameters: { expression } } : null;
            }
            case 'getExchangeRate': {
               const from = asString(parameters.from) || 'USD';
               const to = asString(parameters.to) || 'ILS';
               return { tool, parameters: { from, to } };
            }
            case 'getWeather': {
               const city = asString(parameters.city);
               return city ? { tool, parameters: { city } } : null;
            }
            case 'generalChat': {
               const message = asString(parameters.message) || userInput;
               return message ? { tool, parameters: { message } } : null;
            }
            case 'ragGeneration': {
               const ragPayload = asString(parameters.ragPayload);
               return ragPayload ? { tool, parameters: { ragPayload } } : null;
            }
            case 'analyzeReview': {
               const reviewText = asString(parameters.review_text);
               return reviewText
                  ? { tool, parameters: { review_text: reviewText } }
                  : null;
            }
            case 'orchestrationSynthesis': {
               return Object.keys(parameters).length > 0
                  ? { tool, parameters }
                  : null;
            }
            case 'getProductInformation': {
               const query =
                  asString(parameters.query) ||
                  asString(parameters.product_name);
               return query
                  ? { tool, parameters: { ...parameters, query } }
                  : null;
            }
            default:
               return null;
         }
      })();
      if (normalizedStep) normalizedPlan.push(normalizedStep);
   }

   if (normalizedPlan.length === 0) {
      throw new Error('Plan has no valid executable steps');
   }

   return {
      plan: normalizedPlan,
      final_answer_synthesis_required: synth,
   };
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
   planJson: PlanPayload,
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

const ensureExchangeAndMath = (planJson: PlanPayload, userInput: string) => {
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
         const dedupeKey = incomingConversationId
            ? `${commandType ?? 'unknown'}:${incomingConversationId}`
            : null;
         if (dedupeKey) {
            if (await hasBeenProcessed(idempotencyStore, dedupeKey)) return;
         }
         if (commandType === 'UserControl') {
            try {
               validateOrThrow(schemaPaths.userControl, command);
            } catch (error) {
               await sendToDlq(command, (error as Error).message);
               if (dedupeKey) await markProcessed(idempotencyStore, dedupeKey);
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
            if (dedupeKey) await markProcessed(idempotencyStore, dedupeKey);
            return;
         }

         try {
            validateOrThrow(schemaPaths.userQueryReceived, command);
         } catch (error) {
            await sendToDlq(command, (error as Error).message);
            if (dedupeKey) await markProcessed(idempotencyStore, dedupeKey);
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

         let planJson: PlanPayload;
         try {
            const ollamaText = await chatWithOllama({
               model: 'llama3',
               system: routerPrompt,
               user: payload.userInput,
            });
            planJson = normalizePlanPayload(
               parsePlan(ollamaText),
               payload.userInput
            );
         } catch {
            const fallbackText = await generateWithOpenAI({
               model: 'gpt-3.5-turbo',
               instructions: routerPrompt,
               prompt: payload.userInput,
               maxTokens: 240,
               temperature: 0,
            });
            planJson = normalizePlanPayload(
               parsePlan(fallbackText),
               payload.userInput
            );
         }

         try {
            const productName = detectProductName(payload.userInput);
            if (productName) {
               ensureRagSteps(planJson, payload.userInput, productName);
            }
            ensureExchangeAndMath(planJson, payload.userInput);
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
            if (dedupeKey) await markProcessed(idempotencyStore, dedupeKey);
         } catch (error) {
            await sendToDlq(planJson, (error as Error).message);
            if (dedupeKey) await markProcessed(idempotencyStore, dedupeKey);
         }
      } catch (error) {
         console.error('router-service failed:', error);
         await sendToDlq(
            message.value ? message.value.toString() : null,
            (error as Error).message
         );
      }
   },
   'router-service'
);
