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
      await store.get(key);
      return true;
   } catch (error) {
      if ((error as { notFound?: boolean }).notFound) return false;
      throw error;
   }
};

export const markProcessed = async (
   store: Level<string, IdempotencyRecord>,
   key: string
) => {
   await store.put(key, { seenAt: new Date().toISOString() });
};
