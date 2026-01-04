import fs from 'fs';
import path from 'path';
import { conversationRepository } from '../repositories/conversation.repository';
import template from '../llm/prompts/chatbot.txt';
import { llmClient } from '../llm/client';

const parkInfo = fs.readFileSync(
   path.join(__dirname, '..', 'llm', 'prompts', 'WonderWorld.md'),
   'utf-8'
);
const instructions = template.replace('{{parkInfo}}', parkInfo);

type ChatResponse = {
   id: string;
   message: string;
};

type MessageRole = 'user' | 'assistant' | 'system';

type Message = {
   role: MessageRole;
   content: string;
};

type Intent = 'weather' | 'math' | 'exchange_rate' | 'general';

type IntentResult = {
   intent: Intent;
   city?: string;
   expression?: string;
   currencyCode?: string;
};

async function getWeather(_city: string): Promise<string> {
   return 'לא הצלחתי להביא את הנתונים על מזג האוויר כרגע, נסה שוב מאוחר יותר.';
}

function calculateMath(_expression: string): number {
   return Number.NaN;
}

function getExchangeRate(_currencyCode: string): string {
   return 'לא מכיר את קוד המטבע שביקשת.';
}

async function generalChat(
   _context: Message[],
   userInput: string,
   conversationId: string
): Promise<ChatResponse> {
   const response = await llmClient.generateText({
      model: 'gpt-4o-mini',
      instructions,
      prompt: userInput,
      temperature: 0.2,
      maxTokens: 200,
      previousResponseId:
         conversationRepository.getLastResponseId(conversationId),
   });

   conversationRepository.setLastResponseId(conversationId, response.id);

   return {
      id: response.id,
      message: response.text,
   };
}

async function classifyIntent(_message: string): Promise<IntentResult> {
   return { intent: 'general' };
}

async function routeMessage(
   history: Message[],
   userInput: string,
   conversationId: string
): Promise<ChatResponse> {
   if (userInput.trim() === '/reset') {
      return {
         id: crypto.randomUUID(),
         message: 'היסטוריית השיחה אופסה. נתחיל שיחה חדשה.',
      };
   }

   const classification = await classifyIntent(userInput);

   if (classification.intent === 'weather') {
      return {
         id: crypto.randomUUID(),
         message: await getWeather(classification.city ?? ''),
      };
   }

   if (classification.intent === 'math') {
      const result = calculateMath(classification.expression ?? '');
      return {
         id: crypto.randomUUID(),
         message: Number.isFinite(result)
            ? `התוצאה היא ${result}`
            : 'לא הצלחתי לחשב את הביטוי שביקשת.',
      };
   }

   if (classification.intent === 'exchange_rate') {
      return {
         id: crypto.randomUUID(),
         message: getExchangeRate(classification.currencyCode ?? ''),
      };
   }

   return generalChat(history, userInput, conversationId);
}

// Public interface
export const chatService = {
   async sendMessage(
      prompt: string,
      conversationId: string
   ): Promise<ChatResponse> {
      return routeMessage([], prompt, conversationId);
   },
};
