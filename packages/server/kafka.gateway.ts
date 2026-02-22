import { Kafka, Partitioners } from 'kafkajs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type BotResponse = {
   message: string;
};

type PendingResolver = (message: BotResponse) => void;

const kafka = new Kafka({
   clientId: 'web-gateway',
   brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
});
const producer = kafka.producer({
   createPartitioner: Partitioners.LegacyPartitioner,
});
const consumer = kafka.consumer({
   groupId: 'web-gateway-group',
   allowAutoTopicCreation: true,
});

const pendingResponses = new Map<string, PendingResolver[]>();
let initialized = false;

const topics = {
   userCommands: 'user-commands',
   conversationEvents: 'conversation-events',
   toolInvocationRequests: 'tool-invocation-requests',
   synthesisRequests: 'synthesis-requests',
   deadLetterQueue: 'dead-letter-queue',
   schemaRegistry: 'schema-registry',
} as const;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const runConsumerWithRestart = async (delayMs = 2000) => {
   while (true) {
      try {
         await consumer.run({
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
         return;
      } catch (error) {
         console.error('web-gateway consumer crashed, restarting...', error);
         await delay(delayMs);
      }
   }
};

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

let publishedSchemas = false;
const publishSchemasOnce = async () => {
   if (publishedSchemas) return;
   const schemaRoot = path.resolve('src', 'schemas');
   if (!fs.existsSync(schemaRoot)) return;
   const entries: Array<{ schemaPath: string; schema: unknown }> = [];
   const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
         const fullPath = path.join(dir, entry.name);
         if (entry.isDirectory()) walk(fullPath);
         if (entry.isFile() && entry.name.endsWith('.json')) {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const schema = JSON.parse(raw);
            const schemaPath = path
               .relative(schemaRoot, fullPath)
               .replace(/\\/g, '/');
            entries.push({ schemaPath, schema });
         }
      }
   };
   walk(schemaRoot);
   if (!entries.length) return;
   await producer.send({
      topic: topics.schemaRegistry,
      messages: entries.map((entry) => ({
         key: entry.schemaPath,
         value: JSON.stringify(entry),
      })),
   });
   publishedSchemas = true;
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
   await publishSchemasOnce();
   await consumer.connect();
   await consumer.subscribe({
      topic: topics.conversationEvents,
      fromBeginning: false,
   });
   void runConsumerWithRestart();
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
   await producer.send({
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
   await producer.send({
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
