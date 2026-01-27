import './env';
import OpenAI from 'openai';
import {
   createKafka,
   createProducer,
   ensureTopics,
   parseMessage,
   startConsumer,
   waitForKafka,
} from './kafka';
import { AppResultEvent, IntentGeneralChatEvent, topics } from './types';

const kafka = createKafka('general-chat-app');
const consumer = kafka.consumer({ groupId: 'general-chat-app-group' });
const producer = createProducer(kafka);
const openaiApiKey = process.env.OPENAI_API_KEY ?? '';
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

const systemPrompt =
   'אתה עוזר חכם וקצר בתשובותיו. השתמש בהיסטוריית השיחה שסופקה כדי לענות על שאלות על מה שנאמר קודם. אל תגיד שאין לך גישה להיסטוריה אם היא סופקה.';

await waitForKafka(kafka);
await ensureTopics(kafka, [topics.intentGeneralChat, topics.appResults]);

await producer.connect();
await consumer.connect();
await consumer.subscribe({
   topic: topics.intentGeneralChat,
   fromBeginning: true,
});

startConsumer({
   consumer,
   label: 'general-chat-app',
   eachMessage: async ({ message }) => {
      const parsed = parseMessage<IntentGeneralChatEvent>(message);
      if (!parsed) return;

      const contextMessages = parsed.value.context.map((turn) => ({
         role: turn.role,
         content: turn.content,
      }));

      const result = await (async () => {
         if (!openai) {
            return 'חסר OPENAI_API_KEY כדי להריץ שיחה כללית.';
         }

         const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
               { role: 'system', content: systemPrompt },
               ...contextMessages,
               { role: 'user', content: parsed.value.userInput },
            ],
            temperature: 0.2,
            max_tokens: 200,
         });

         return response.choices[0]?.message?.content ?? '';
      })();
      const payload: AppResultEvent = { type: 'chat', result };

      await producer.send({
         topic: topics.appResults,
         messages: [{ key: parsed.key, value: JSON.stringify(payload) }],
      });
   },
});
