import OpenAI from 'openai';
import { createKafka, parseMessage } from './kafka';
import { AppResultEvent, IntentGeneralChatEvent, topics } from './types';

const kafka = createKafka('general-chat-app');
const consumer = kafka.consumer({ groupId: 'general-chat-app-group' });
const producer = kafka.producer();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const systemPrompt = 'אתה עוזר חכם וקצר בתשובותיו. תן תשובות ברורות וממוקדות.';

await producer.connect();
await consumer.connect();
await consumer.subscribe({
   topic: topics.intentGeneralChat,
   fromBeginning: true,
});

consumer.run({
   eachMessage: async ({ message }) => {
      const parsed = parseMessage<IntentGeneralChatEvent>(message);
      if (!parsed) return;

      const contextMessages = parsed.value.context.map((turn) => ({
         role: turn.role,
         content: turn.content,
      }));

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

      const result = response.choices[0]?.message?.content ?? '';
      const payload: AppResultEvent = { type: 'chat', result };

      await producer.send({
         topic: topics.appResults,
         messages: [{ key: parsed.key, value: JSON.stringify(payload) }],
      });
   },
});
