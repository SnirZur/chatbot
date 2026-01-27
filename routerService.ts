import './env';
import fs from 'node:fs';
import path from 'node:path';
import {
   createKafka,
   createProducer,
   ensureTopics,
   parseMessage,
   startConsumer,
   waitForKafka,
} from './kafka';
import {
   type ConversationHistory,
   type HistoryUpdateEvent,
   type IntentExchangeEvent,
   type IntentGeneralChatEvent,
   type IntentMathEvent,
   type IntentWeatherEvent,
   topics,
   type UserInputEvent,
} from './types';

const kafka = createKafka('router-service');
const consumer = kafka.consumer({ groupId: 'router-service-group' });
const producer = createProducer(kafka);

const historyCache = new Map<string, ConversationHistory>();
const historyFilePath = path.resolve('history.json');

const loadHistoryForUser = (userId: string): ConversationHistory => {
   try {
      if (!fs.existsSync(historyFilePath)) return [];
      const raw = fs.readFileSync(historyFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, ConversationHistory>;
      const history = parsed?.[userId];
      return Array.isArray(history) ? history : [];
   } catch (error) {
      console.error('Failed to load history for user:', error);
      return [];
   }
};

const normalize = (text: string) => text.toLowerCase();

const extractMathExpression = (input: string): string | null => {
   let expression = input;
   const replacements: Array<[RegExp, string]> = [
      [/ועוד/g, '+'],
      [/פלוס/g, '+'],
      [/פחות/g, '-'],
      [/מינוס/g, '-'],
      [/כפול/g, '*'],
      [/חלקי/g, '/'],
      [/לחלק/g, '/'],
   ];

   for (const [pattern, replacement] of replacements) {
      expression = expression.replace(pattern, ` ${replacement} `);
   }

   const onlyMath = expression.replace(/[^0-9+\-*/(). ]/g, ' ').trim();
   if (!onlyMath) return null;

   if (!/[0-9]/.test(onlyMath) || !/[+\-*/]/.test(onlyMath)) return null;
   return onlyMath.replace(/\s+/g, ' ');
};

const extractCity = (input: string): string | null => {
   const matchHebrew = input.match(/ב([\u0590-\u05FF ]{2,})/);
   if (matchHebrew && matchHebrew[1]) {
      return matchHebrew[1].trim();
   }

   const matchEnglish = input.match(/in ([A-Za-z ]{2,})/i);
   if (matchEnglish && matchEnglish[1]) {
      return matchEnglish[1].trim();
   }

   return null;
};

const extractCurrency = (input: string): string | null => {
   const upper = input.toUpperCase();
   if (upper.includes('USD') || input.includes('דולר')) return 'USD';
   if (
      upper.includes('EUR') ||
      input.includes('יורו') ||
      input.includes('אירו')
   )
      return 'EUR';
   if (upper.includes('GBP') || input.includes('פאונד')) return 'GBP';
   return null;
};

await waitForKafka(kafka);
await ensureTopics(kafka, [
   topics.userInput,
   topics.historyUpdate,
   topics.intentMath,
   topics.intentWeather,
   topics.intentExchange,
   topics.intentGeneralChat,
]);

await producer.connect();
await consumer.connect();
await consumer.subscribe({ topic: topics.userInput, fromBeginning: true });
await consumer.subscribe({ topic: topics.historyUpdate, fromBeginning: true });

startConsumer({
   consumer,
   label: 'router-service',
   eachMessage: async ({ topic, message }) => {
      if (topic === topics.historyUpdate) {
         const parsed = parseMessage<HistoryUpdateEvent>(message);
         if (!parsed) return;
         historyCache.set(parsed.key, parsed.value.history);
         return;
      }

      if (topic !== topics.userInput) return;
      const parsed = parseMessage<UserInputEvent>(message);
      if (!parsed) return;

      const userId = parsed.key;
      const userInput = parsed.value.userInput;
      const normalized = normalize(userInput);

      const mathExpression = extractMathExpression(normalized);
      if (mathExpression) {
         const payload: IntentMathEvent = { expression: mathExpression };
         await producer.send({
            topic: topics.intentMath,
            messages: [{ key: userId, value: JSON.stringify(payload) }],
         });
         return;
      }

      if (
         normalized.includes('מזג האוויר') ||
         normalized.includes('כמה חם') ||
         normalized.includes('weather')
      ) {
         const city = extractCity(userInput) ?? 'תל אביב';
         const payload: IntentWeatherEvent = { city };
         await producer.send({
            topic: topics.intentWeather,
            messages: [{ key: userId, value: JSON.stringify(payload) }],
         });
         return;
      }

      if (
         normalized.includes('דולר') ||
         normalized.includes('יורו') ||
         normalized.includes('אירו') ||
         normalized.includes('exchange')
      ) {
         const currencyCode = extractCurrency(userInput) ?? 'USD';
         const payload: IntentExchangeEvent = { currencyCode };
         await producer.send({
            topic: topics.intentExchange,
            messages: [{ key: userId, value: JSON.stringify(payload) }],
         });
         return;
      }

      const payload: IntentGeneralChatEvent = {
         context: historyCache.get(userId) ?? loadHistoryForUser(userId),
         userInput,
      };
      await producer.send({
         topic: topics.intentGeneralChat,
         messages: [{ key: userId, value: JSON.stringify(payload) }],
      });
   },
});
