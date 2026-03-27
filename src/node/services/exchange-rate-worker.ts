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

const EXCHANGE_RATE_HOST_ACCESS_KEY = process.env.EXCHANGE_RATE_HOST_ACCESS_KEY;
const fxCache = new Map<string, { rate: number; expiresAt: number }>();
const FX_CACHE_TTL_MS = 5 * 60 * 1000;
async function fetchFxRate(from: string, to: string): Promise<number> {
   if (!EXCHANGE_RATE_HOST_ACCESS_KEY) {
      throw new Error('Missing EXCHANGE_RATE_HOST_ACCESS_KEY');
   }

   const url = new URL('https://api.exchangerate.host/convert');
   url.searchParams.set('access_key', EXCHANGE_RATE_HOST_ACCESS_KEY);
   url.searchParams.set('from', from);
   url.searchParams.set('to', to);
   url.searchParams.set('amount', '1');

   const res = await fetch(url.toString());
   if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
         `FX API error: ${res.status} ${res.statusText} ${body}`.trim()
      );
   }

   const data = (await res.json()) as { result?: number };

   const rate = data.result;
   if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      throw new Error('FX API response missing numeric rate in "result"');
   }

   return rate;
}

const kafka = createKafka('exchange-rate-worker');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'exchange-rate-worker-group');

const idempotencyStore = createIdempotencyStore(
   '.state/idempotency/exchange-rate-worker'
);

const getExchangeRate = async (from: string, to = 'ILS') => {
   const normalizedFrom = from.trim().toUpperCase();
   const normalizedTo = (to ?? 'ILS').trim().toUpperCase() || 'ILS';

   if (!normalizedFrom) return { text: 'לא מכיר את קוד המטבע שביקשת.' };

   if (normalizedTo !== 'ILS')
      return { text: 'כרגע אני תומך רק בשער מול ש״ח.' };

   const cacheKey = `${normalizedFrom}->${normalizedTo}`;
   const cached = fxCache.get(cacheKey);
   const now = Date.now();
   if (cached && cached.expiresAt > now) {
      const rate = cached.rate;
      return { text: `שער ${normalizedFrom} היציג הוא ${rate} ש״ח`, rate };
   }

   const rate = await fetchFxRate(normalizedFrom, normalizedTo);
   fxCache.set(cacheKey, { rate, expiresAt: now + FX_CACHE_TTL_MS });

   return { text: `שער ${normalizedFrom} היציג הוא ${rate} ש״ח`, rate };
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
   fromBeginning: false,
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
         const result = await getExchangeRate(from, to);

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
