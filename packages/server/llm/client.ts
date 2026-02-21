import { InferenceClient } from '@huggingface/inference';
import { Ollama } from 'ollama';
import OpenAI from 'openai';
import summarizePrompt from '../llm/prompts/summarize-reviews.txt';

const openAIClient = new OpenAI({
   apiKey: process.env.OPENAI_API_KEY,
});

const inferenceClient = new InferenceClient(process.env.HF_TOKEN);

const ollamaClient = new Ollama();

type GenerateTextOptions = {
   model?: string;
   prompt: string;
   instructions?: string;
   temperature?: number;
   maxTokens?: number;
   previousResponseId?: string;
   responseFormat?: {
      type: 'json_object';
   };
};

type GenerateTextResult = {
   id: string;
   text: string;
};

type ChatMessage = {
   role: 'system' | 'user' | 'assistant';
   content: string;
};

export const llmClient = {
   async generateText({
      model = 'gpt-4.1',
      prompt,
      instructions,
      temperature = 0.2,
      maxTokens = 300,
      previousResponseId,
      responseFormat,
   }: GenerateTextOptions): Promise<GenerateTextResult> {
      const start = Date.now();
      const response = await openAIClient.responses.create({
         model,
         input: prompt,
         instructions,
         temperature,
         max_output_tokens: maxTokens,
         previous_response_id: previousResponseId,
      });
      const duration = Date.now() - start;
      console.log(
         `[LLM] provider=openai action=responses.create model=${model} duration=${duration}ms`
      );

      return {
         id: response.id,
         text: response.output_text,
      };
   },

   async chatCompletion({
      model = 'gpt-4o-mini',
      messages,
      temperature = 0.2,
      maxTokens = 300,
   }: {
      model?: string;
      messages: ChatMessage[];
      temperature?: number;
      maxTokens?: number;
   }): Promise<GenerateTextResult> {
      const start = Date.now();
      const response = await openAIClient.chat.completions.create({
         model,
         messages,
         temperature,
         max_tokens: maxTokens,
      });
      const duration = Date.now() - start;
      console.log(
         `[LLM] provider=openai action=chat.completions.create model=${model} duration=${duration}ms`
      );

      return {
         id: response.id,
         text: response.choices[0]?.message?.content ?? '',
      };
   },

   async chatCompletionOllama({
      model = 'llama3',
      messages,
   }: {
      model?: string;
      messages: ChatMessage[];
   }): Promise<GenerateTextResult> {
      try {
         const start = Date.now();
         const response = await ollamaClient.chat({
            model,
            messages,
         });
         const duration = Date.now() - start;
         console.log(
            `[LLM] provider=ollama action=chat model=${model} duration=${duration}ms`
         );

         return {
            id: response.message?.role ?? 'ollama',
            text: response.message?.content ?? '',
         };
      } catch (err) {
         console.error(
            '[LLM] ollama chat failed, falling back to OpenAI:',
            err instanceof Error ? err.message : err
         );
         const start = Date.now();
         const response = await openAIClient.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: messages as any,
            temperature: 0.2,
            max_tokens: 300,
         });
         const duration = Date.now() - start;
         console.log(
            `[LLM] provider=openai action=chat.completions.create model=gpt-4o-mini duration=${duration}ms (fallback from ollama)`
         );

         return {
            id: response.id,
            text: response.choices[0]?.message?.content ?? '',
         };
      }
   },

   async summarizeReviews(reviews: string) {
      try {
         const start = Date.now();
         const response = await ollamaClient.chat({
            model: 'llama3',
            messages: [
               {
                  role: 'system',
                  content: summarizePrompt,
               },
               {
                  role: 'user',
                  content: reviews,
               },
            ],
         });
         const duration = Date.now() - start;
         console.log(
            `[LLM] provider=ollama action=summarize model=llama3 duration=${duration}ms`
         );

         return response.message.content;
      } catch (err) {
         console.error(
            '[LLM] ollama summarize failed, falling back to OpenAI:',
            err instanceof Error ? err.message : err
         );
         const start = Date.now();
         const response = await openAIClient.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
               { role: 'system', content: summarizePrompt },
               { role: 'user', content: reviews },
            ],
            temperature: 0.2,
            max_tokens: 300,
         });
         const duration = Date.now() - start;
         console.log(
            `[LLM] provider=openai action=chat.completions.create model=gpt-4o-mini duration=${duration}ms (fallback from ollama)`
         );

         return response.choices[0]?.message?.content ?? '';
      }
   },
};
