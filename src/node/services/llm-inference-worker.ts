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
   ANALYZE_REVIEW_PROMPT,
   GENERAL_CHAT_PROMPT,
   ORCHESTRATION_SYNTHESIS_PROMPT,
   RAG_GENERATION_PROMPT,
} from '../lib/prompts';
import {
   publishSchemasOnce,
   startSchemaRegistryConsumer,
} from '../lib/schemaRegistry';
import {
   createIdempotencyStore,
   hasBeenProcessed,
   markProcessed,
} from '../lib/idempotencyStore';

const kafka = createKafka('llm-inference-worker');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'llm-inference-worker-group');

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
await publishSchemasOnce(producer);
await startSchemaRegistryConsumer(kafka, 'llm-inference-schema-registry');
const consumer = await consumerPromise;

await consumer.subscribe({
   topic: topics.toolInvocationRequests,
   fromBeginning: false,
});

const idempotencyStore = createIdempotencyStore(
   '.state/idempotency/llm-inference-worker'
);

const PRICE_QUERY_PATTERN = /\b(price|prices|cost|pricing)\b|מחיר|מחירים|₪|\$/i;

const buildPriceOnlyAnswer = (ragPayload: string) => {
   const question =
      ragPayload.match(/User question:\s*([^\n]+)/i)?.[1]?.trim() ?? '';
   const isPriceQuery = PRICE_QUERY_PATTERN.test(question || ragPayload);
   if (!isPriceQuery) return null;

   const knowledge = (() => {
      const marker = 'Knowledge:';
      const index = ragPayload.indexOf(marker);
      return index >= 0 ? ragPayload.slice(index + marker.length) : ragPayload;
   })();

   const products = [
      'BrewMaster 360',
      'EvoPhone X',
      'PrintForge Mini',
      'VoltRider E2',
   ];

   const lines: string[] = [];
   for (const product of products) {
      const regex = new RegExp(
         `${product.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}[\\s\\S]{0,600}?Price:\\s*([^\\n.]+)`,
         'i'
      );
      const match = knowledge.match(regex);
      if (match?.[1]) {
         lines.push(`${product}: ${match[1].trim()}`);
      }
   }

   if (lines.length > 0) {
      return `מחירי המוצרים:\n${lines.join('\n')}`;
   }

   const rawPriceLines = knowledge
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /price\s*:|\$\s*\d|₪|USD/i.test(line));
   if (rawPriceLines.length > 0) {
      return `מחירי המוצרים:\n${rawPriceLines.join('\n')}`;
   }

   return 'לא מצאתי מחירים מפורשים בנתונים שסופקו.';
};

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

      try {
         validateOrThrow(schemaPaths.toolInvocationRequested, command);
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
         payload: {
            invocationId: string;
            tool: string;
            parameters: Record<string, unknown>;
            stepIndex: number;
         };
      };

      if (await hasBeenProcessed(idempotencyStore, payload.invocationId)) {
         return;
      }

      try {
         let result: unknown;

         if (payload.tool === 'generalChat') {
            const userInput = String(payload.parameters.message ?? '').trim();
            if (!userInput) throw new Error('generalChat requires message');
            let text: string;

            try {
               text = await chatWithOllama({
                  model: 'llama3',
                  system: GENERAL_CHAT_PROMPT,
                  user: userInput,
               });
            } catch (err) {
               console.warn(
                  'Ollama failed in generalChat, falling back to OpenAI:',
                  err
               );
               text = await generateWithOpenAI({
                  model: 'gpt-3.5-turbo',
                  instructions: GENERAL_CHAT_PROMPT,
                  prompt: userInput,
                  maxTokens: 300,
                  temperature: 0.2,
               });
            }

            result = { text };
         } else if (payload.tool === 'ragGeneration') {
            const ragPayload = String(
               payload.parameters.ragPayload ?? ''
            ).trim();
            if (!ragPayload)
               throw new Error('ragGeneration requires ragPayload');
            const priceOnly = buildPriceOnlyAnswer(ragPayload);
            if (priceOnly) {
               result = { text: priceOnly };
            } else {
               let text = '';
               try {
                  text = await generateWithOpenAI({
                     model: 'gpt-3.5-turbo',
                     instructions: RAG_GENERATION_PROMPT,
                     prompt: ragPayload,
                     maxTokens: 220,
                     temperature: 0.2,
                     timeoutMs: 15000,
                  });
               } catch {
                  try {
                     text = await chatWithOllama({
                        model: 'llama3',
                        system: RAG_GENERATION_PROMPT,
                        user: ragPayload,
                        timeoutMs: 15000,
                     });
                  } catch {
                     // Last-resort fallback keeps orchestration alive if LLM providers are unavailable.
                     text =
                        ragPayload.split('Knowledge:').pop()?.trim() ||
                        'Unable to synthesize with model providers right now, but retrieved relevant product information.';
                  }
               }
               result = {
                  text,
               };
            }
         } else if (payload.tool === 'analyzeReview') {
            const reviewText = String(
               payload.parameters.review_text ?? ''
            ).trim();
            if (!reviewText)
               throw new Error('analyzeReview requires review_text');
            result = {
               text: await generateWithOpenAI({
                  model: 'gpt-3.5-turbo',
                  instructions: ANALYZE_REVIEW_PROMPT,
                  prompt: reviewText,
                  maxTokens: 120,
                  temperature: 0.2,
               }),
            };
         } else if (payload.tool === 'orchestrationSynthesis') {
            const synthesisPayload = JSON.stringify(
               payload.parameters ?? {},
               null,
               2
            );
            result = {
               text: await generateWithOpenAI({
                  model: 'gpt-3.5-turbo',
                  instructions: ORCHESTRATION_SYNTHESIS_PROMPT,
                  prompt: synthesisPayload,
                  maxTokens: 200,
                  temperature: 0.2,
               }),
            };
         } else {
            return;
         }

         await sendEvent(
            producer,
            schemaPaths.toolInvocationResulted,
            conversationId,
            {
               conversationId,
               userId,
               timestamp: new Date().toISOString(),
               eventType: 'ToolInvocationResulted',
               payload: {
                  invocationId: payload.invocationId,
                  tool: payload.tool,
                  stepIndex: payload.stepIndex,
                  result,
               },
            }
         );
         await markProcessed(idempotencyStore, payload.invocationId);
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
         await sendEvent(producer, schemaPaths.planFailed, conversationId, {
            conversationId,
            userId,
            timestamp: new Date().toISOString(),
            eventType: 'PlanFailed',
            payload: { reason: (error as Error).message },
         });
         await markProcessed(idempotencyStore, payload.invocationId);
      }
   },
   'llm-inference-worker'
);
