import OpenAI from 'openai';
import { Ollama } from 'ollama';

const openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ollamaClient = new Ollama({
   host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
});

export const generateWithOpenAI = async ({
   model = 'gpt-3.5-turbo',
   instructions,
   prompt,
   maxTokens = 300,
   temperature = 0,
}: {
   model?: string;
   instructions?: string;
   prompt: string;
   maxTokens?: number;
   temperature?: number;
}) => {
   const safePrompt = prompt && prompt.trim().length > 0 ? prompt : ' ';
   const response = await openAIClient.chat.completions.create({
      model,
      messages: [
         ...(instructions ? [{ role: 'system', content: instructions }] : []),
         { role: 'user', content: safePrompt },
      ],
      temperature,
      max_tokens: maxTokens,
   });
   return response.choices[0]?.message?.content ?? '';
};

export const chatWithOllama = async ({
   model = 'llama3',
   system,
   user,
}: {
   model?: string;
   system: string;
   user: string;
}) => {
   const response = await ollamaClient.chat({
      model,
      messages: [
         { role: 'system', content: system },
         { role: 'user', content: user },
      ],
   });
   return response.message.content;
};
