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

const kafka = createKafka('math-worker');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(kafka, 'math-worker-group');

const idempotencyStore = createIdempotencyStore(
   '.state/idempotency/math-worker'
);

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

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
await publishSchemasOnce(producer);
await startSchemaRegistryConsumer(kafka, 'math-worker-schema-registry');
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

      if (payload.tool !== 'calculateMath') return;
      if (await hasBeenProcessed(idempotencyStore, payload.invocationId)) {
         return;
      }

      try {
         const expression = String(payload.parameters.expression ?? '');
         const value = calculateMath(expression);
         const result = {
            text: Number.isFinite(value)
               ? `התוצאה היא ${value}`
               : 'לא הצלחתי לחשב את הביטוי שביקשת.',
            data: value,
         };

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
   'math-worker'
);
