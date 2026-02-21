import { Kafka, Partitioners, type Consumer, type Producer } from 'kafkajs';
import { topics } from './topics';

const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');

export const createKafka = (clientId: string) =>
   new Kafka({ clientId, brokers });

export const createProducer = async (kafka: Kafka): Promise<Producer> => {
   const producer = kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
   });
   await producer.connect();
   return producer;
};

export const createConsumer = async (
   kafka: Kafka,
   groupId: string
): Promise<Consumer> => {
   const consumer = kafka.consumer({ groupId });
   await consumer.connect();
   return consumer;
};

export const ensureTopics = async (kafka: Kafka) => {
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

export const waitForKafka = async (
   kafka: Kafka,
   retries = 20,
   delayMs = 3000
) => {
   for (let attempt = 1; attempt <= retries; attempt += 1) {
      const admin = kafka.admin();
      try {
         await admin.connect();
         await admin.disconnect();
         return;
      } catch {
         await admin.disconnect().catch(() => undefined);
         await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
   }
   throw new Error('Kafka not ready after retries');
};
