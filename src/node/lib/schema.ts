import Ajv, { type ValidateFunction } from 'ajv';
import fs from 'node:fs';
import path from 'node:path';
import { topics } from './topics';
import { getRegistrySchema } from './schemaRegistry';

const ajv = new Ajv({ allErrors: true, strict: false });

const schemaCache = new Map<string, ValidateFunction>();

const schemaRoot = path.resolve('src', 'schemas');

const loadSchema = (schemaPath: string) => {
   const cached = getRegistrySchema(schemaPath);
   if (cached) return cached;
   const fullPath = path.resolve(schemaRoot, schemaPath);
   const raw = fs.readFileSync(fullPath, 'utf-8');
   return JSON.parse(raw);
};

export const getValidator = (schemaPath: string) => {
   if (schemaCache.has(schemaPath)) {
      return schemaCache.get(schemaPath)!;
   }
   const schema = loadSchema(schemaPath);
   const validator = ajv.compile(schema);
   schemaCache.set(schemaPath, validator);
   return validator;
};

export const validateOrThrow = (schemaPath: string, payload: unknown) => {
   const validator = getValidator(schemaPath);
   const valid = validator(payload);
   if (!valid) {
      const error = new Error(
         `Schema validation failed for ${schemaPath}: ${ajv.errorsText(validator.errors)}`
      );
      (error as Error & { errors?: unknown }).errors = validator.errors;
      throw error;
   }
};

export const schemaPaths = {
   userQueryReceived: 'commands/userQueryReceived.json',
   userControl: 'commands/userControl.json',
   toolInvocationRequested: 'commands/toolInvocationRequested.json',
   synthesizeFinalAnswerRequested:
      'commands/synthesizeFinalAnswerRequested.json',
   planGenerated: 'events/planGenerated.json',
   toolInvocationRequestedEvent: 'events/toolInvocationRequested.json',
   planStepCompleted: 'events/planStepCompleted.json',
   toolInvocationResulted: 'events/toolInvocationResulted.json',
   planCompleted: 'events/planCompleted.json',
   planFailed: 'events/planFailed.json',
   finalAnswerSynthesized: 'events/finalAnswerSynthesized.json',
   userQueryEvent: 'events/userQueryReceived.json',
   userHistoryReset: 'events/userHistoryReset.json',
};

export const topicSchemaMap = {
   [topics.userCommands]: schemaPaths.userQueryReceived,
   [topics.toolInvocationRequests]: schemaPaths.toolInvocationRequested,
   [topics.synthesisRequests]: schemaPaths.synthesizeFinalAnswerRequested,
   [topics.conversationEvents]: null,
   [topics.deadLetterQueue]: null,
} as const;
