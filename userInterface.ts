import './env';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
   createKafka,
   createProducer,
   parseMessage,
   startConsumer,
} from './kafka';
import { topics, type UserControlEvent, type UserInputEvent } from './types';

const kafka = createKafka('ui-service');
const producer = createProducer(kafka);
const consumer = kafka.consumer({ groupId: 'ui-service-group' });

const historyFile = Bun.file('history.json');
if (!(await historyFile.exists())) {
   console.log('No history found.');
} else {
   console.log('History found.');
}

const rl = readline.createInterface({ input, output });
const userIdInput = await rl.question(
   'Enter user id (leave empty for random): '
);
const userId = userIdInput.trim() || crypto.randomUUID();
console.log(`Using userId: ${userId}`);

await producer.connect();
await consumer.connect();
await consumer.subscribe({ topic: topics.botResponses, fromBeginning: true });

startConsumer({
   consumer,
   label: 'ui-service',
   eachMessage: async ({ message }) => {
      const parsed = parseMessage<{ message: string }>(message);
      if (!parsed || parsed.key !== userId) return;
      console.log(`\nBot: ${parsed.value.message}`);
   },
});

while (true) {
   const prompt = await rl.question('You: ');
   const trimmed = prompt.trim();
   if (!trimmed) continue;

   if (trimmed === '/reset') {
      const payload: UserControlEvent = { command: 'reset' };
      await producer.send({
         topic: topics.userControl,
         messages: [{ key: userId, value: JSON.stringify(payload) }],
      });
      continue;
   }

   const payload: UserInputEvent = { userInput: trimmed };
   await producer.send({
      topic: topics.userInput,
      messages: [{ key: userId, value: JSON.stringify(payload) }],
   });
}
