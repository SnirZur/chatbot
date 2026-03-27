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
import { ROUTER_SYSTEM_PROMPT } from '../lib/prompts';
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

type PlanStep = {
   id: string;
   purpose: string;
   dependsOn: string[];
   tool: ToolName;
   parameters: Record<string, unknown>;
};
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

const defaultStepMetadata = (tool: ToolName, position: number) => ({
   id: `step_${position + 1}`,
   purpose: `Run ${tool}`,
   dependsOn: position === 0 ? [] : [`step_${position}`],
});

const extractDependsOnFromParameters = (
   parameters: Record<string, unknown>
) => {
   const refs =
      JSON.stringify(parameters).match(/<result_from_tool_(\d+)>/g) ?? [];
   return Array.from(
      new Set(
         refs.map((ref) => {
            const match = ref.match(/<result_from_tool_(\d+)>/);
            return match ? `step_${match[1]}` : '';
         })
      )
   ).filter((value) => value.length > 0);
};

const finalizePlanMetadata = (plan: PlanStep[]) => {
   for (const [index, step] of plan.entries()) {
      step.id = `step_${index + 1}`;
      step.purpose = step.purpose || `Run ${step.tool}`;
      step.dependsOn = extractDependsOnFromParameters(step.parameters);
   }
};

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
   for (const [index, rawStep] of planRaw.entries()) {
      const normalizedStep = (() => {
         const step = getObject(rawStep);
         if (!step) return null;
         const tool = asString(step.tool) as ToolName;
         const parameters = getObject(step.parameters) ?? {};
         const id = asString(step.id) || `step_${index + 1}`;
         const purpose = asString(step.purpose) || `Run ${tool}`;
         const dependsOn = Array.isArray(step.dependsOn)
            ? step.dependsOn
                 .map((value) => asString(value))
                 .filter((value) => value.length > 0)
            : index === 0
              ? []
              : [`step_${index}`];
         const withMetadata = (nextParameters: Record<string, unknown>) => ({
            id,
            purpose,
            dependsOn,
            tool,
            parameters: nextParameters,
         });

         switch (tool) {
            case 'calculateMath': {
               const expression = asString(parameters.expression);
               return expression ? withMetadata({ expression }) : null;
            }
            case 'getExchangeRate': {
               const from = asString(parameters.from) || 'USD';
               const to = asString(parameters.to) || 'ILS';
               return withMetadata({ from, to });
            }
            case 'getWeather': {
               const city = asString(parameters.city);
               return city ? withMetadata({ city }) : null;
            }
            case 'generalChat': {
               const message = asString(parameters.message) || userInput;
               return message ? withMetadata({ message }) : null;
            }
            case 'ragGeneration': {
               const ragPayload = asString(parameters.ragPayload);
               return ragPayload ? withMetadata({ ragPayload }) : null;
            }
            case 'analyzeReview': {
               const reviewText = asString(parameters.review_text);
               return reviewText
                  ? withMetadata({ review_text: reviewText })
                  : null;
            }
            case 'orchestrationSynthesis': {
               return Object.keys(parameters).length > 0
                  ? withMetadata(parameters)
                  : null;
            }
            case 'getProductInformation': {
               const query =
                  asString(parameters.query) ||
                  asString(parameters.product_name);
               return query ? withMetadata({ ...parameters, query }) : null;
            }
            default:
               return null;
         }
      })();
      if (normalizedStep) normalizedPlan.push(normalizedStep);
   }

   if (normalizedPlan.length === 0) {
      // Safe fallback to keep pipeline alive when model output is malformed.
      normalizedPlan.push({
         ...defaultStepMetadata('generalChat', 0),
         tool: 'generalChat',
         parameters: { message: userInput || 'שלום' },
      });
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
   let productStepIndex = plan.findIndex(
      (step) => step.tool === 'getProductInformation'
   );
   let ragStepIndex = plan.findIndex((step) => step.tool === 'ragGeneration');

   if (productStepIndex === -1) {
      const insertAt = ragStepIndex === -1 ? plan.length : ragStepIndex;
      plan.splice(insertAt, 0, {
         ...defaultStepMetadata('getProductInformation', insertAt),
         tool: 'getProductInformation',
         parameters: { query: productName },
      });
      productStepIndex = insertAt;
      if (ragStepIndex !== -1) ragStepIndex += 1;
   }

   // If product step exists after rag, move it before rag so placeholder is resolvable.
   if (ragStepIndex !== -1 && productStepIndex > ragStepIndex) {
      const [productStep] = plan.splice(productStepIndex, 1);
      plan.splice(ragStepIndex, 0, productStep);
      productStepIndex = ragStepIndex;
      ragStepIndex += 1;
   }

   const ragPayload = `User question: ${userInput}\nKnowledge: <result_from_tool_${productStepIndex + 1}>`;
   if (ragStepIndex === -1) {
      plan.push({
         ...defaultStepMetadata('ragGeneration', plan.length),
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
         ...defaultStepMetadata('getExchangeRate', insertAt),
         tool: 'getExchangeRate',
         parameters: { from: 'USD', to: 'ILS' },
      });
      exchangeIndex = insertAt;
      if (mathIndex !== -1) mathIndex += 1;
   }

   const expression = `${shekel} - (${usd} * <result_from_tool_${exchangeIndex + 1}>)`;

   if (mathIndex === -1) {
      plan.push({
         ...defaultStepMetadata('calculateMath', plan.length),
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

const buildFallbackPlan = (userInput: string): PlanPayload => {
   const normalizedInput = userInput.trim();
   const asksProductInfo = /מחיר|מחירים|product|products|price|prices/i.test(
      normalizedInput
   );

   if (asksProductInfo) {
      return {
         plan: [
            {
               ...defaultStepMetadata('getProductInformation', 0),
               tool: 'getProductInformation',
               parameters: { query: normalizedInput || 'products and prices' },
            },
            {
               ...defaultStepMetadata('ragGeneration', 1),
               tool: 'ragGeneration',
               parameters: {
                  ragPayload:
                     `User question: ${normalizedInput}\n` +
                     'Knowledge: <result_from_tool_1>',
               },
            },
         ],
         final_answer_synthesis_required: true,
      };
   }

   return {
      plan: [
         {
            ...defaultStepMetadata('generalChat', 0),
            tool: 'generalChat',
            parameters: { message: normalizedInput || 'שלום' },
         },
      ],
      final_answer_synthesis_required: true,
   };
};

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
await publishSchemasOnce(producer);
await startSchemaRegistryConsumer(kafka, 'router-service-schema-registry');
const consumer = await consumerPromise;

await consumer.subscribe({ topic: topics.userCommands, fromBeginning: false });

await runConsumerWithRestart(
   consumer,
   async ({ message }) => {
      try {
         if (!message.value) return;
         const command = JSON.parse(message.value.toString());
         console.log('router-service received command', command);
         const commandType = command.commandType as string | undefined;
         const incomingConversationId = String(command.conversationId ?? '');
         const dedupeKey = incomingConversationId
            ? `${commandType ?? 'unknown'}:${incomingConversationId}`
            : null;
         if (dedupeKey) {
            if (await hasBeenProcessed(idempotencyStore, dedupeKey)) {
               console.log(
                  'router-service skipping already processed',
                  dedupeKey
               );
               return;
            }
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

         console.log('router-service about to emit UserQueryEvent', {
            conversationId,
            userId,
            timestamp,
            userInput: payload.userInput,
         });
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
               system: ROUTER_SYSTEM_PROMPT,
               user: payload.userInput,
               timeoutMs: 15000,
            });
            planJson = normalizePlanPayload(
               parsePlan(ollamaText),
               payload.userInput
            );
         } catch (ollamaError) {
            try {
               const fallbackText = await generateWithOpenAI({
                  model: 'gpt-3.5-turbo',
                  instructions: ROUTER_SYSTEM_PROMPT,
                  prompt: payload.userInput,
                  maxTokens: 240,
                  temperature: 0,
                  timeoutMs: 15000,
               });
               planJson = normalizePlanPayload(
                  parsePlan(fallbackText),
                  payload.userInput
               );
            } catch (openaiError) {
               console.warn(
                  'router-service falling back to deterministic plan',
                  {
                     ollamaError: (ollamaError as Error).message,
                     openaiError: (openaiError as Error).message,
                  }
               );
               planJson = buildFallbackPlan(payload.userInput);
            }
         }

         try {
            const productName = detectProductName(payload.userInput);
            if (productName) {
               ensureRagSteps(planJson, payload.userInput, productName);
            }
            ensureExchangeAndMath(planJson, payload.userInput);
            if (planJson.plan.length > 1) {
               planJson.final_answer_synthesis_required = true;
            }
            finalizePlanMetadata(planJson.plan);
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
         console.error('router-service failed processing message', error);
         await sendToDlq(
            message.value ? message.value.toString() : null,
            (error as Error).message
         );
      }
   },
   'router-service'
);
