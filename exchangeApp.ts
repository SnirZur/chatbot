import { createKafka, parseMessage } from './kafka';
import { AppResultEvent, IntentExchangeEvent, topics } from './types';

const kafka = createKafka('exchange-app');
const consumer = kafka.consumer({ groupId: 'exchange-app-group' });
const producer = kafka.producer();

const getExchangeRate = (currencyCode: string): string => {
   const normalized = currencyCode.trim().toUpperCase();
   const rates: Record<string, number> = {
      USD: 3.75,
      EUR: 4.05,
      GBP: 4.7,
   };

   const labels: Record<string, string> = {
      USD: 'הדולר',
      EUR: 'האירו',
      GBP: 'הליש"ט',
   };

   const rate = rates[normalized];
   if (!rate) return 'לא מכיר את קוד המטבע שביקשת.';
   const label = labels[normalized] ?? normalized;
   return `שער ${label} היציג הוא ${rate} ש"ח`;
};

await producer.connect();
await consumer.connect();
await consumer.subscribe({ topic: topics.intentExchange, fromBeginning: true });

consumer.run({
   eachMessage: async ({ message }) => {
      const parsed = parseMessage<IntentExchangeEvent>(message);
      if (!parsed) return;

      const result = getExchangeRate(parsed.value.currencyCode);
      const payload: AppResultEvent = { type: 'exchange', result };

      await producer.send({
         topic: topics.appResults,
         messages: [{ key: parsed.key, value: JSON.stringify(payload) }],
      });
   },
});
