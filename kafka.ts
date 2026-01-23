import { Kafka } from 'kafkajs';

type ParsedMessage<T> = {
   key: string;
   value: T;
};

export const createKafka = (clientId: string) =>
   new Kafka({ clientId, brokers: ['localhost:9092'] });

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
