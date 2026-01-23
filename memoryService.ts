import path from 'path';
import { createKafka, parseMessage } from './kafka';
import {
   AppResultEvent,
   ConversationHistory,
   HistoryUpdateEvent,
   topics,
   UserControlEvent,
   UserInputEvent,
} from './types';

const kafka = createKafka('memory-service');
const consumer = kafka.consumer({ groupId: 'memory-service-group' });
const producer = kafka.producer();

const historyFilePath = path.resolve('history.json');
const historyMap = new Map<string, ConversationHistory>();

const loadHistory = async () => {
   try {
      const file = Bun.file(historyFilePath);
      if (!(await file.exists())) return;
      const data = await file.text();
      const parsed = JSON.parse(data) as Record<string, ConversationHistory>;
      if (parsed && typeof parsed === 'object') {
         for (const [userId, history] of Object.entries(parsed)) {
            if (Array.isArray(history)) {
               historyMap.set(userId, history);
            }
         }
      }
   } catch (error) {
      console.error('Failed to load history:', error);
   }
};

const saveHistory = async () => {
   try {
      const obj: Record<string, ConversationHistory> = {};
      for (const [userId, history] of historyMap.entries()) {
         obj[userId] = history;
      }
      await Bun.write(historyFilePath, JSON.stringify(obj, null, 2));
   } catch (error) {
      console.error('Failed to save history:', error);
   }
};

const publishHistory = async (userId: string) => {
   const history = historyMap.get(userId) ?? [];
   const payload: HistoryUpdateEvent = { history };
   await producer.send({
      topic: topics.historyUpdate,
      messages: [{ key: userId, value: JSON.stringify(payload) }],
   });
};

await loadHistory();

await producer.connect();
await consumer.connect();
await consumer.subscribe({ topic: topics.userInput, fromBeginning: true });
await consumer.subscribe({ topic: topics.appResults, fromBeginning: true });
await consumer.subscribe({ topic: topics.userControl, fromBeginning: true });

for (const userId of historyMap.keys()) {
   await publishHistory(userId);
}

consumer.run({
   eachMessage: async ({ topic, message }) => {
      const key = message.key?.toString() ?? '';
      if (!key) return;

      if (topic === topics.userInput) {
         const parsed = parseMessage<UserInputEvent>(message);
         if (!parsed) return;
         const history = historyMap.get(key) ?? [];
         history.push({ role: 'user', content: parsed.value.userInput });
         historyMap.set(key, history);
         await saveHistory();
         await publishHistory(key);
         return;
      }

      if (topic === topics.appResults) {
         const parsed = parseMessage<AppResultEvent>(message);
         if (!parsed) return;
         const history = historyMap.get(key) ?? [];
         history.push({ role: 'assistant', content: parsed.value.result });
         historyMap.set(key, history);
         await saveHistory();
         await publishHistory(key);
         return;
      }

      if (topic === topics.userControl) {
         const parsed = parseMessage<UserControlEvent>(message);
         if (!parsed || parsed.value.command !== 'reset') return;
         historyMap.delete(key);
         await saveHistory();
         await publishHistory(key);
      }
   },
});
