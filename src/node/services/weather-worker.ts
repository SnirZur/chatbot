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

const kafka = createKafka('weather-worker');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'weather-worker-group');

const idempotencyStore = createIdempotencyStore(
   '.state/idempotency/weather-worker'
);

const getWeather = async (city: string) => {
   const apiKey = process.env.WEATHER_API_KEY;
   if (!apiKey)
      return 'לא הצלחתי להביא את הנתונים על מזג האוויר כרגע, נסה שוב מאוחר יותר.';
   const normalizedCity = city.trim();
   if (!normalizedCity) return 'לא הצלחתי להבין לאיזו עיר אתה מתכוון.';
   const url = new URL('https://api.openweathermap.org/data/2.5/weather');
   url.searchParams.set('q', normalizedCity);
   url.searchParams.set('appid', apiKey);
   url.searchParams.set('units', 'metric');
   url.searchParams.set('lang', 'he');
   const response = await fetch(url);
   if (!response.ok) throw new Error('Weather API request failed');
   const data = await response.json();
   const temp = Number(data?.main?.temp);
   const description = data?.weather?.[0]?.description;
   if (!Number.isFinite(temp) || typeof description !== 'string') {
      throw new Error('Weather API returned invalid data');
   }
   return `${Math.round(temp)} מעלות, ${description}`;
};

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
await publishSchemasOnce(producer);
await startSchemaRegistryConsumer(kafka, 'weather-worker-schema-registry');
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

      if (payload.tool !== 'getWeather') return;
      if (await hasBeenProcessed(idempotencyStore, payload.invocationId)) {
         return;
      }

      try {
         const city = String(payload.parameters.city ?? '');
         const result = { text: await getWeather(city) };

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
   'weather-worker'
);
