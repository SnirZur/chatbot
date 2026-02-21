import fs from 'node:fs';
import path from 'node:path';
import {
   createKafka,
   createProducer,
   createConsumer,
   ensureTopics,
   waitForKafka,
} from '../lib/kafka';
import { topics } from '../lib/topics';
import { schemaPaths, validateOrThrow } from '../lib/schema';
import { sendEvent } from '../lib/producer';
import { chatWithOllama, generateWithOpenAI } from '../lib/llm';

const kafka = createKafka('llm-inference-worker');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'llm-inference-worker-group');

const generalChatPrompt = fs.readFileSync(
   path.resolve('prompts/general-chat.txt'),
   'utf-8'
);
const ragGenerationPrompt = fs.readFileSync(
   path.resolve('prompts/rag-generation.txt'),
   'utf-8'
);
const analyzeReviewPrompt = fs.readFileSync(
   path.resolve('prompts/analyze-review.txt'),
   'utf-8'
);

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
const consumer = await consumerPromise;

await consumer.subscribe({
   topic: topics.toolInvocationRequests,
   fromBeginning: true,
});

const processed = new Set<string>();

await consumer.run({
   eachMessage: async ({ message }) => {
      if (!message.value) return;
      const command = JSON.parse(message.value.toString());
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

      if (processed.has(payload.invocationId)) return;
      processed.add(payload.invocationId);

      let result: unknown;

      if (payload.tool === 'generalChat') {
         const userInput = String(payload.parameters.message ?? '');
         result = {
            text: await chatWithOllama({
               model: 'llama3',
               system: generalChatPrompt,
               user: userInput,
            }),
         };
      } else if (payload.tool === 'ragGeneration') {
         const ragPayload = String(payload.parameters.ragPayload ?? '');
         result = {
            text: await generateWithOpenAI({
               model: 'gpt-3.5-turbo',
               instructions: ragGenerationPrompt,
               prompt: ragPayload,
               maxTokens: 220,
               temperature: 0.2,
            }),
         };
      } else if (payload.tool === 'analyzeReview') {
         const reviewText = String(payload.parameters.review_text ?? '');
         result = {
            text: await generateWithOpenAI({
               model: 'gpt-3.5-turbo',
               instructions: analyzeReviewPrompt,
               prompt: reviewText,
               maxTokens: 120,
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
   },
});
