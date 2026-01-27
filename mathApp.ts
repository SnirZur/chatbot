import './env';
import {
   createKafka,
   createProducer,
   ensureTopics,
   parseMessage,
   startConsumer,
   waitForKafka,
} from './kafka';
import { type AppResultEvent, type IntentMathEvent, topics } from './types';

const kafka = createKafka('math-app');
const consumer = kafka.consumer({ groupId: 'math-app-group' });
const producer = createProducer(kafka);

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
      switch (operator) {
         case '+':
            values.push(left + right);
            return;
         case '-':
            values.push(left - right);
            return;
         case '*':
            values.push(left * right);
            return;
         case '/':
            values.push(left / right);
            return;
         default:
            values.push(Number.NaN);
      }
   };

   let index = 0;
   while (index < trimmed.length) {
      const char = trimmed[index];
      const prevChar = trimmed[index - 1] ?? '';
      const isUnary =
         (char === '+' || char === '-') &&
         (index === 0 || /[+\-*/(]/.test(prevChar));

      if (/\d|\./.test(char ?? '') || isUnary) {
         let start = index;
         index += 1;
         while (index < trimmed.length && /[\d.]/.test(trimmed[index] ?? '')) {
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
         while (operators.length && operators[operators.length - 1] !== '(') {
            applyOperator();
         }
         operators.pop();
         index += 1;
         continue;
      }

      if (!/[+\-*/]/.test(char)) return Number.NaN;

      while (
         operators.length > 0 &&
         operators[operators.length - 1] !== '(' &&
         precedence[operators[operators.length - 1]] >= precedence[char]
      ) {
         applyOperator();
      }

      operators.push(char);
      index += 1;
   }

   while (operators.length > 0) {
      applyOperator();
   }

   return values.length === 1 ? values[0] : Number.NaN;
};

await waitForKafka(kafka);
await ensureTopics(kafka, [topics.intentMath, topics.appResults]);

await producer.connect();
await consumer.connect();
await consumer.subscribe({ topic: topics.intentMath, fromBeginning: true });

startConsumer({
   consumer,
   label: 'math-app',
   eachMessage: async ({ message }) => {
      const parsed = parseMessage<IntentMathEvent>(message);
      if (!parsed) return;

      const result = calculateMath(parsed.value.expression);
      const payload: AppResultEvent = {
         type: 'math',
         result: Number.isFinite(result)
            ? `התוצאה היא ${result}`
            : 'לא הצלחתי לחשב את הביטוי.',
      };

      await producer.send({
         topic: topics.appResults,
         messages: [{ key: parsed.key, value: JSON.stringify(payload) }],
      });
   },
});
