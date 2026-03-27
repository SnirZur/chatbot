import OpenAI from 'openai';
import { Ollama } from 'ollama';

const openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ollamaClient = new Ollama({
   host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
});

const withTimeout = async <T>(
   promise: Promise<T>,
   timeoutMs: number,
   label: string
) => {
   let timer: ReturnType<typeof setTimeout> | undefined;
   try {
      return await Promise.race([
         promise,
         new Promise<T>((_resolve, reject) => {
            timer = setTimeout(() => {
               reject(new Error(`${label} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
         }),
      ]);
   } finally {
      if (timer) clearTimeout(timer);
   }
};

export const generateWithOpenAI = async ({
   model = 'gpt-3.5-turbo',
   instructions,
   prompt,
   maxTokens = 300,
   temperature = 0,
   timeoutMs = 15000,
}: {
   model?: string;
   instructions?: string;
   prompt: string;
   maxTokens?: number;
   temperature?: number;
   timeoutMs?: number;
}) => {
   const safePrompt = prompt && prompt.trim().length > 0 ? prompt : ' ';
   const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...(instructions
         ? [{ role: 'system' as const, content: instructions }]
         : []),
      { role: 'user' as const, content: safePrompt },
   ];
   const response = await withTimeout(
      openAIClient.chat.completions.create({
         model,
         messages,
         temperature,
         max_tokens: maxTokens,
      }),
      timeoutMs,
      'OpenAI completion'
   );
   return response.choices[0]?.message?.content ?? '';
};

export const chatWithOllama = async ({
   model = 'llama3',
   system,
   user,
   timeoutMs = 15000,
}: {
   model?: string;
   system: string;
   user: string;
   timeoutMs?: number;
}) => {
   const response = await withTimeout(
      ollamaClient.chat({
         model,
         messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
         ],
      }),
      timeoutMs,
      'Ollama chat'
   );
   return response.message.content;
};
