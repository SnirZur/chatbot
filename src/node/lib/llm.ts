import OpenAI from 'openai';
import { Ollama } from 'ollama';

const openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ollamaClient = new Ollama();

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
   const response = await openAIClient.responses.create({
      model,
      input: prompt,
      instructions,
      temperature,
      max_output_tokens: maxTokens,
   });
   return response.output_text;
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
