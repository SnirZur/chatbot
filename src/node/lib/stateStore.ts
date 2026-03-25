import { Level } from 'level';

export type OrchestratorState = {
   conversationId: string;
   userId: string;
   plan: Array<{ tool: string; parameters: Record<string, unknown> }>;
   final_answer_synthesis_required: boolean;
   stepIndex: number;
   results: Array<{ tool: string; result: unknown }>;
   status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
};

export const createStateStore = (path: string) => {
   return new Level<string, OrchestratorState>(path, { valueEncoding: 'json' });
};
