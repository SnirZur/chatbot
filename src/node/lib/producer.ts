import type { Producer } from 'kafkajs';
import { validateOrThrow, schemaPaths } from './schema';
import { topics } from './topics';

export const sendCommand = async (
   producer: Producer,
   commandType: keyof typeof schemaPaths,
   topic: string,
   key: string,
   payload: unknown
) => {
   validateOrThrow(schemaPaths[commandType], payload);
   await producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(payload) }],
   });
};

export const sendEvent = async (
   producer: Producer,
   schemaPath: string,
   key: string,
   payload: unknown
) => {
   validateOrThrow(schemaPath, payload);
   await producer.send({
      topic: topics.conversationEvents,
      messages: [{ key, value: JSON.stringify(payload) }],
   });
};
