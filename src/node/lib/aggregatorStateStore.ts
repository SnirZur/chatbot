import { Level } from 'level';

export type AggregatorConversationState = {
   userInput: string;
   toolResults: unknown[];
   synthesisRequested: boolean;
};

export const createAggregatorStateStore = (path: string) =>
   new Level<string, AggregatorConversationState>(path, {
      valueEncoding: 'json',
   });
