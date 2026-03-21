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
   fromBeginning: true,
});

const idempotencyStore = createIdempotencyStore(
   '.state/idempotency/llm-inference-worker'
);

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
            result = {
               text: await chatWithOllama({
                  model: 'llama3',
                  system: GENERAL_CHAT_PROMPT,
                  user: userInput,
               }),
            };
         } else if (payload.tool === 'ragGeneration') {
            const ragPayload = String(
               payload.parameters.ragPayload ?? ''
            ).trim();
            if (!ragPayload)
               throw new Error('ragGeneration requires ragPayload');
            result = {
               text: await generateWithOpenAI({
                  model: 'gpt-3.5-turbo',
                  instructions: RAG_GENERATION_PROMPT,
                  prompt: ragPayload,
                  maxTokens: 220,
                  temperature: 0.2,
               }),
            };
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
