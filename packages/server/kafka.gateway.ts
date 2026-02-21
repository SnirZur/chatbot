import { Kafka, Partitioners } from 'kafkajs';
import { randomUUID } from 'node:crypto';

type BotResponse = {
   message: string;
};

type PendingResolver = (message: BotResponse) => void;

let kafka: Kafka | null = null;
let producer: ReturnType<Kafka['producer']> | null = null;
let consumer: ReturnType<Kafka['consumer']> | null = null;

const pendingResponses = new Map<string, PendingResolver[]>();
let initialized = false;

const topics = {
   userCommands: 'user-commands',
   conversationEvents: 'conversation-events',
   toolInvocationRequests: 'tool-invocation-requests',
   synthesisRequests: 'synthesis-requests',
   deadLetterQueue: 'dead-letter-queue',
} as const;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForKafka = async (retries = 20, delayMs = 3000) => {
   for (let attempt = 1; attempt <= retries; attempt += 1) {
      const admin = kafka!.admin();
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
   const admin = kafka!.admin();
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
   if (!kafka) {
      kafka = new Kafka({
         clientId: 'web-gateway',
         brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      });
   }
   if (!producer) {
      producer = kafka.producer({
         createPartitioner: Partitioners.LegacyPartitioner,
      });
   }
   if (!consumer) {
      consumer = kafka.consumer({ groupId: 'web-gateway-group' });
   }
   await waitForKafka();
   try {
      await ensureTopics();
   } catch (error) {
      console.warn('Topic creation failed or already exists:', error);
   }
   await producer!.connect();
   await consumer!.connect();
   await consumer!.subscribe({
      topic: topics.conversationEvents,
      fromBeginning: false,
   });
   consumer!.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const value = JSON.parse(message.value.toString()) as {
               conversationId?: string;
               eventType?: string;
               payload?: { message?: string };
            };
            if (value.eventType !== 'FinalAnswerSynthesized') return;
            const conversationId = value.conversationId ?? '';
            if (!conversationId) return;
            const queue = pendingResponses.get(conversationId);
            const resolver = queue?.shift();
            if (resolver && value.payload?.message) {
               resolver({ message: value.payload.message });
            }
         } catch (error) {
            console.error('Failed to parse bot response:', error);
         }
      },
   });
   initialized = true;
};

export const isKafkaReady = async () => {
   if (!kafka) {
      kafka = new Kafka({
         clientId: 'web-gateway',
         brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      });
   }
   const admin = kafka!.admin();
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

const waitForResponse = (conversationId: string, timeoutMs = 30000) =>
   new Promise<BotResponse>((resolve, reject) => {
      const queue = pendingResponses.get(conversationId) ?? [];
      const timer = setTimeout(() => {
         const current = pendingResponses.get(conversationId) ?? [];
         pendingResponses.set(
            conversationId,
            current.filter((item) => item !== resolve)
         );
         reject(new Error('Timed out waiting for bot response'));
      }, timeoutMs);

      const wrappedResolve: PendingResolver = (message) => {
         clearTimeout(timer);
         resolve(message);
      };

      queue.push(wrappedResolve);
      pendingResponses.set(conversationId, queue);
   });

export const sendUserInput = async (userId: string, userInput: string) => {
   await init();
   const conversationId = randomUUID();
   await producer!.send({
      topic: topics.userCommands,
      messages: [
         {
            key: conversationId,
            value: JSON.stringify({
               conversationId,
               userId,
               timestamp: new Date().toISOString(),
               commandType: 'UserQueryReceived',
               payload: { userInput },
            }),
         },
      ],
   });

   return waitForResponse(conversationId);
};

export const sendReset = async (userId: string) => {
   await init();
   await producer!.send({
      topic: topics.userCommands,
      messages: [
         {
            key: userId,
            value: JSON.stringify({
               conversationId: randomUUID(),
               userId,
               timestamp: new Date().toISOString(),
               commandType: 'UserControl',
               payload: { command: 'reset' },
            }),
         },
      ],
   });
};
