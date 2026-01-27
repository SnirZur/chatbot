import { Kafka, Partitioners } from 'kafkajs';

type BotResponse = {
   message: string;
};

type PendingResolver = (message: BotResponse) => void;

const kafka = new Kafka({
   clientId: 'web-gateway',
   brokers: ['localhost:9092'],
});
const producer = kafka.producer({
   createPartitioner: Partitioners.LegacyPartitioner,
});
const consumer = kafka.consumer({ groupId: 'web-gateway-group' });

const pendingResponses = new Map<string, PendingResolver[]>();
let initialized = false;

const topics = {
   userInput: 'user-input-events',
   userControl: 'user-control-events',
   botResponses: 'bot-responses',
   historyUpdate: 'conversation-history-update',
   appResults: 'app-results',
   intentMath: 'intent-math',
   intentWeather: 'intent-weather',
   intentExchange: 'intent-exchange',
   intentGeneralChat: 'intent-general-chat',
} as const;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForKafka = async (retries = 20, delayMs = 3000) => {
   for (let attempt = 1; attempt <= retries; attempt += 1) {
      const admin = kafka.admin();
      try {
         await admin.connect();
         await admin.disconnect();
         return;
      } catch (error) {
         await admin.disconnect().catch(() => undefined);
         console.warn(
            `Kafka not ready (attempt ${attempt}/${retries}), retrying...`
         );
         await delay(delayMs);
      }
   }
   throw new Error('Kafka not ready after retries');
};

const ensureTopics = async () => {
   const admin = kafka.admin();
   await admin.connect();
   try {
      await admin.createTopics({
         topics: Object.values(topics).map((topic) => ({
            topic,
            numPartitions: 1,
            replicationFactor: 1,
         })),
         waitForLeaders: true,
      });
   } finally {
      await admin.disconnect();
   }
};

const init = async () => {
   if (initialized) return;
   await waitForKafka();
   try {
      await ensureTopics();
   } catch (error) {
      console.warn('Topic creation failed or already exists:', error);
   }
   await producer.connect();
   await consumer.connect();
   await consumer.subscribe({
      topic: topics.botResponses,
      fromBeginning: false,
   });
   consumer.run({
      eachMessage: async ({ message }) => {
         const key = message.key?.toString() ?? '';
         if (!key || !message.value) return;

         try {
            const value = JSON.parse(message.value.toString()) as BotResponse;
            const queue = pendingResponses.get(key);
            const resolver = queue?.shift();
            if (resolver) {
               resolver(value);
            }
         } catch (error) {
            console.error('Failed to parse bot response:', error);
         }
      },
   });
   initialized = true;
};

export const isKafkaReady = async () => {
   const admin = kafka.admin();
   try {
      await admin.connect();
      const existing = await admin.listTopics();
      const required = Object.values(topics);
      const hasAll = required.every((topic) => existing.includes(topic));
      return hasAll;
   } catch (error) {
      return false;
   } finally {
      await admin.disconnect().catch(() => undefined);
   }
};

const waitForResponse = (userId: string, timeoutMs = 30000) =>
   new Promise<BotResponse>((resolve, reject) => {
      const queue = pendingResponses.get(userId) ?? [];
      const timer = setTimeout(() => {
         const current = pendingResponses.get(userId) ?? [];
         pendingResponses.set(
            userId,
            current.filter((item) => item !== resolve)
         );
         reject(new Error('Timed out waiting for bot response'));
      }, timeoutMs);

      const wrappedResolve: PendingResolver = (message) => {
         clearTimeout(timer);
         resolve(message);
      };

      queue.push(wrappedResolve);
      pendingResponses.set(userId, queue);
   });

export const sendUserInput = async (userId: string, userInput: string) => {
   await init();
   await producer.send({
      topic: topics.userInput,
      messages: [{ key: userId, value: JSON.stringify({ userInput }) }],
   });

   return waitForResponse(userId);
};

export const sendReset = async (userId: string) => {
   await init();
   await producer.send({
      topic: topics.userControl,
      messages: [{ key: userId, value: JSON.stringify({ command: 'reset' }) }],
   });
};
