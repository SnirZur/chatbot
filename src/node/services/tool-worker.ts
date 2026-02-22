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

const kafka = createKafka('tool-worker');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'tool-worker-group');

const processed = new Set<string>();

const calculateMath = (expression: string): number => {
   const trimmed = expression.replace(/\s+/g, '');
   if (!trimmed) return Number.NaN;
   const values: number[] = [];
   const operators: string[] = [];
   const precedence: Record<string, number> = {
      '+': 1,
      '-': 1,
      '*': 2,
      '/': 2,
   };

   const applyOperator = () => {
      const operator = operators.pop();
      const right = values.pop();
      const left = values.pop();
      if (!operator || right === undefined || left === undefined) {
         values.push(Number.NaN);
         return;
      }
      let result = Number.NaN;
      switch (operator) {
         case '+':
            result = left + right;
            break;
         case '-':
            result = left - right;
            break;
         case '*':
            result = left * right;
            break;
         case '/':
            result = left / right;
            break;
         default:
            result = Number.NaN;
      }
      values.push(result);
   };

   let index = 0;
   while (index < trimmed.length) {
      const char = trimmed[index];
      const isUnarySign =
         (char === '+' || char === '-') &&
         (index === 0 || /[+\-*/(]/.test(trimmed[index - 1]!));

      if (/\d|\./.test(char) || isUnarySign) {
         let start = index;
         index += 1;
         while (index < trimmed.length && /[\d.]/.test(trimmed[index])) {
            index += 1;
         }
         const value = Number(trimmed.slice(start, index));
         if (!Number.isFinite(value)) return Number.NaN;
         values.push(value);
         continue;
      }

      if (char === '(') {
         operators.push(char);
         index += 1;
         continue;
      }
      if (char === ')') {
         while (
            operators.length > 0 &&
            operators[operators.length - 1] !== '('
         ) {
            applyOperator();
         }
         if (operators[operators.length - 1] === '(') operators.pop();
         else return Number.NaN;
         index += 1;
         continue;
      }

      if (!/[+\-*\/]/.test(char)) return Number.NaN;

      while (operators.length > 0) {
         const top = operators[operators.length - 1];
         if (top === '(') break;
         if ((precedence[top] ?? 0) >= (precedence[char] ?? 0)) {
            applyOperator();
            continue;
         }
         break;
      }
      operators.push(char);
      index += 1;
   }

   while (operators.length > 0) {
      if (operators[operators.length - 1] === '(') return Number.NaN;
      applyOperator();
   }

   if (values.length !== 1 || !Number.isFinite(values[0])) return Number.NaN;
   return values[0];
};

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
await startSchemaRegistryConsumer(kafka, 'tool-worker-schema-registry');
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

      if (processed.has(payload.invocationId)) return;
      processed.add(payload.invocationId);

      try {
         let result: unknown;
         if (payload.tool === 'calculateMath') {
            const expression = String(payload.parameters.expression ?? '');
            const value = calculateMath(expression);
            result = {
               text: Number.isFinite(value)
                  ? `התוצאה היא ${value}`
                  : 'לא הצלחתי לחשב את הביטוי שביקשת.',
               data: value,
            };
         } else if (payload.tool === 'getExchangeRate') {
            const from = String(payload.parameters.from ?? '');
            const to = String(payload.parameters.to ?? 'ILS');
            result = getExchangeRate(from, to);
         } else if (payload.tool === 'getWeather') {
            const city = String(payload.parameters.city ?? '');
            result = { text: await getWeather(city) };
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
   'tool-worker'
);
