import { Kafka, Partitioners } from 'kafkajs';

type ParsedMessage<T> = {
   key: string;
   value: T;
};

export const createKafka = (clientId: string) =>
   new Kafka({ clientId, brokers: ['localhost:9092'] });

export const createProducer = (kafka: Kafka) =>
   kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });

export const parseMessage = <T>(message: {
   key: Buffer | null;
   value: Buffer | null;
}): ParsedMessage<T> | null => {
   if (!message.value) return null;
   try {
      const value = JSON.parse(message.value.toString()) as T;
      const key = message.key ? message.key.toString() : '';
      return { key, value };
   } catch (error) {
      console.error('Failed to parse Kafka message:', error);
      return null;
   }
};

export const delay = (ms: number) =>
   new Promise((resolve) => setTimeout(resolve, ms));

export const ensureTopics = async (kafka: Kafka, topics: string[]) => {
   const admin = kafka.admin();
   await admin.connect();
   try {
      await admin.createTopics({
         topics: topics.map((topic) => ({
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

export const startConsumer = async (options: {
   consumer: any;
   eachMessage: (payload: any) => Promise<void>;
   label: string;
}) => {
   const { consumer, eachMessage, label } = options;

   const run = async () => {
      try {
         await consumer.run({ eachMessage });
      } catch (error) {
         console.error(`${label} consumer run failed:`, error);
         await delay(2000);
         run();
      }
   };

   consumer.on(consumer.events.CRASH, async (event) => {
      console.error(
         `${label} consumer crashed:`,
         event?.payload?.error ?? event
      );
      await delay(2000);
      run();
   });

   run();
};
