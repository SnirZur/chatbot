import fs from 'node:fs';
import path from 'node:path';

const readPrompt = (fileName: string) =>
   fs.readFileSync(path.resolve('prompts', fileName), 'utf-8');

export const ROUTER_SYSTEM_PROMPT = readPrompt('router.txt');
export const GENERAL_CHAT_PROMPT = readPrompt('general-chat.txt');
export const RAG_GENERATION_PROMPT = readPrompt('rag-generation.txt');
export const ANALYZE_REVIEW_PROMPT = readPrompt('analyze-review.txt');
export const ORCHESTRATION_SYNTHESIS_PROMPT = readPrompt(
   'orchestration-synthesis.txt'
);
