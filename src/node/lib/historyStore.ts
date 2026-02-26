import { Level } from 'level';

export type HistoryMessage = {
   role: 'user' | 'assistant';
   content: string;
};

export type HistoryState = {
   messages: HistoryMessage[];
};

export const createHistoryStore = (path: string) =>
   new Level<string, HistoryState>(path, {
      valueEncoding: 'json',
   });
