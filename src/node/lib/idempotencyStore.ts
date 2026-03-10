import { Level } from 'level';

type IdempotencyRecord = { seenAt: string };

export const createIdempotencyStore = (path: string) => {
   return new Level<string, IdempotencyRecord>(path, { valueEncoding: 'json' });
};

export const hasBeenProcessed = async (
   store: Level<string, IdempotencyRecord>,
   key: string
) => {
   try {
      const value = await store.get(key);
      if (value === undefined || value === null) {
         return false;
      }
      return true;
   } catch (error) {
      console.log('hasBeenProcessed error for key', key, ':', error);
      if ((error as { notFound?: boolean }).notFound) return false;
      return false; // Treat all errors as not processed for safety
   }
};

export const markProcessed = async (
   store: Level<string, IdempotencyRecord>,
   key: string
) => {
   await store.put(key, { seenAt: new Date().toISOString() });
};
