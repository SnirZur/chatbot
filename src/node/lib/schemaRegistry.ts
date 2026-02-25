import fs from 'node:fs';
import path from 'node:path';
import type { Kafka, Producer } from 'kafkajs';
import { topics } from './topics';
import { runConsumerWithRestart } from './kafka';

type RegistryEntry = {
   schemaPath: string;
   schema: unknown;
};

const registryCache = new Map<string, unknown>();
let published = false;

const schemaRoot = path.resolve('src', 'schemas');

const listSchemaFiles = (dir: string): string[] => {
   const entries = fs.readdirSync(dir, { withFileTypes: true });
   const files: string[] = [];
   for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
         files.push(...listSchemaFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
         files.push(fullPath);
      }
   }
   return files;
};

const loadSchemas = (): RegistryEntry[] => {
   const files = listSchemaFiles(schemaRoot);
   return files.map((filePath) => {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const schema = JSON.parse(raw);
      const schemaPath = path
         .relative(schemaRoot, filePath)
         .replace(/\\/g, '/');
      return { schemaPath, schema };
   });
};

export const publishSchemasOnce = async (producer: Producer) => {
   if (published) return;
   const schemas = loadSchemas();
   if (!schemas.length) return;
   await producer.send({
      topic: topics.schemaRegistry,
      messages: schemas.map((entry) => ({
         key: entry.schemaPath,
         value: JSON.stringify(entry),
      })),
   });
   published = true;
};

export const startSchemaRegistryConsumer = async (
   kafka: Kafka,
   groupId: string
) => {
   const consumer = kafka.consumer({
      groupId,
      allowAutoTopicCreation: true,
   });
   await consumer.connect();
   await consumer.subscribe({
      topic: topics.schemaRegistry,
      fromBeginning: true,
   });

   void runConsumerWithRestart(
      consumer,
      async ({ message }) => {
         if (!message.value) return;
         try {
            const value = JSON.parse(message.value.toString()) as RegistryEntry;
            if (!value?.schemaPath) return;
            registryCache.set(value.schemaPath, value.schema);
         } catch {
            // Ignore malformed registry messages.
         }
      },
      `schema-registry-${groupId}`
   );
};

export const getRegistrySchema = (schemaPath: string) =>
   registryCache.get(schemaPath);
