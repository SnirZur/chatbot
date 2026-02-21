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
      const response = await openAIClient.responses.create({
         model,
         input: prompt,
         instructions,
         temperature,
         max_output_tokens: maxTokens,
         previous_response_id: previousResponseId,
      });

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
      const response = await openAIClient.chat.completions.create({
         model,
         messages,
         temperature,
         max_tokens: maxTokens,
      });

      return {
         id: response.id,
         text: response.choices[0]?.message?.content ?? '',
      };
   },

   async chatCompletionOllama({
      model = 'tinyllama',
      messages,
   }: {
      model?: string;
      messages: ChatMessage[];
   }): Promise<GenerateTextResult> {
      const response = await ollamaClient.chat({
         model,
         messages,
      });

      return {
         id: response.message?.role ?? 'ollama',
         text: response.message?.content ?? '',
      };
   },

   async summarizeReviews(reviews: string) {
      const response = await ollamaClient.chat({
         model: 'tinyllama',
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

      return response.message.content;
   },
};
