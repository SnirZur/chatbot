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
import {
   createIdempotencyStore,
   hasBeenProcessed,
   markProcessed,
} from '../lib/idempotencyStore';

const kafka = createKafka('exchange-rate-worker');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'exchange-rate-worker-group');

const idempotencyStore = createIdempotencyStore(
   '.state/idempotency/exchange-rate-worker'
);

const getExchangeRate = (from: string, to = 'ILS') => {
   const normalizedFrom = from.trim().toUpperCase();
   const normalizedTo = to.trim().toUpperCase() || 'ILS';
   if (!normalizedFrom) return { text: 'לא מכיר את קוד המטבע שביקשת.' };
   if (normalizedTo !== 'ILS')
      return { text: 'כרגע אני תומך רק בשער מול ש״ח.' };
   const rates: Record<string, number> = {
      USD: 3.75,
      EUR: 4.05,
      GBP: 4.7,
      JPY: 0.026,
   };
   const labels: Record<string, string> = {
      USD: 'הדולר',
      EUR: 'האירו',
      GBP: 'הליש״ט',
      JPY: 'היין היפני',
   };
   const rate = rates[normalizedFrom];
   if (!rate) return { text: 'לא מכיר את קוד המטבע שביקשת.' };
   const label = labels[normalizedFrom] ?? normalizedFrom;
   return { text: `שער ${label} היציג הוא ${rate} ש״ח`, rate };
};

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
await publishSchemasOnce(producer);
await startSchemaRegistryConsumer(
   kafka,
   'exchange-rate-worker-schema-registry'
);
const consumer = await consumerPromise;

await consumer.subscribe({
   topic: topics.toolInvocationRequests,
   fromBeginning: true,
});

await runConsumerWithRestart(
   consumer,
   async ({ message }) => {
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

      if (payload.tool !== 'getExchangeRate') return;
      if (await hasBeenProcessed(idempotencyStore, payload.invocationId)) {
         return;
      }

      try {
         const from = String(payload.parameters.from ?? '');
         const to = String(payload.parameters.to ?? 'ILS');
         const result = getExchangeRate(from, to);

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
         await sendEvent(producer, schemaPaths.planFailed, conversationId, {
            conversationId,
            userId,
            timestamp: new Date().toISOString(),
            eventType: 'PlanFailed',
            payload: { reason: (error as Error).message },
         });
      }
   },
   'exchange-rate-worker'
);
