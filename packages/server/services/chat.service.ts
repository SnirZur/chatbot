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

async function getWeather(city: string): Promise<string> {
   const apiKey = process.env.WEATHER_API_KEY;
   if (!apiKey) {
      return 'לא הצלחתי להביא את הנתונים על מזג האוויר כרגע, נסה שוב מאוחר יותר.';
   }

   const normalizedCity = city.trim();
   if (!normalizedCity) {
      return 'לא הצלחתי להבין לאיזו עיר אתה מתכוון.';
   }

   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), 5000);

   try {
      const url = new URL('https://api.openweathermap.org/data/2.5/weather');
      url.searchParams.set('q', normalizedCity);
      url.searchParams.set('appid', apiKey);
      url.searchParams.set('units', 'metric');
      url.searchParams.set('lang', 'he');

      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
         throw new Error('Weather API request failed.');
      }

      const data = await response.json();
      const temp = Number(data?.main?.temp);
      const description = data?.weather?.[0]?.description;

      if (!Number.isFinite(temp) || typeof description !== 'string') {
         throw new Error('Weather API returned invalid data.');
      }

      return `${Math.round(temp)} מעלות, ${description}`;
   } catch (error) {
      console.error(error);
      return 'לא הצלחתי להביא את הנתונים על מזג האוויר כרגע, נסה שוב מאוחר יותר.';
   } finally {
      clearTimeout(timeout);
   }
}

function calculateMath(expression: string): number {
   const trimmed = expression.replace(/\s+/g, '');
   if (!trimmed) {
      return Number.NaN;
   }

   const values: number[] = [];
   const operators: string[] = [];
   const precedence: Record<string, number> = {
      '+': 1,
      '-': 1,
      '*': 2,
      '/': 2,
   };

   const applyOperator = () => {
      const operator = operators.pop();
      const right = values.pop();
      const left = values.pop();
      if (!operator || right === undefined || left === undefined) {
         values.push(Number.NaN);
         return;
      }

      let result = Number.NaN;
      switch (operator) {
         case '+':
            result = left + right;
            break;
         case '-':
            result = left - right;
            break;
         case '*':
            result = left * right;
            break;
         case '/':
            result = left / right;
            break;
         default:
            result = Number.NaN;
      }

      values.push(result);
   };

   let index = 0;
   while (index < trimmed.length) {
      const char = trimmed[index];
      const isUnarySign =
         (char === '+' || char === '-') &&
         (index === 0 || /[+\-*/]/.test(trimmed[index - 1]));

      if (/\d|\./.test(char) || isUnarySign) {
         let start = index;
         index += 1;
         while (index < trimmed.length && /[\d.]/.test(trimmed[index])) {
            index += 1;
         }
         const value = Number(trimmed.slice(start, index));
         if (!Number.isFinite(value)) {
            return Number.NaN;
         }
         values.push(value);
         continue;
      }

      if (!/[+\-*/]/.test(char)) {
         return Number.NaN;
      }

      while (
         operators.length > 0 &&
         precedence[operators[operators.length - 1]] >= precedence[char]
      ) {
         applyOperator();
      }

      operators.push(char);
      index += 1;
   }

   while (operators.length > 0) {
      applyOperator();
   }

   if (values.length !== 1 || !Number.isFinite(values[0])) {
      return Number.NaN;
   }

   return values[0];
}

function getExchangeRate(currencyCode: string): string {
   const normalizedCode = currencyCode.trim().toUpperCase();
   if (!normalizedCode) {
      return 'לא מכיר את קוד המטבע שביקשת.';
   }

   const rates: Record<string, number> = {
      USD: 3.75,
      EUR: 4.05,
      GBP: 4.7,
      JPY: 0.026,
   };

   const labels: Record<string, string> = {
      USD: 'הדולר',
      EUR: 'האירו',
      GBP: 'הליש״ט',
      JPY: 'היין היפני',
   };

   const rate = rates[normalizedCode];
   if (!rate) {
      return 'לא מכיר את קוד המטבע שביקשת.';
   }

   const label = labels[normalizedCode] ?? normalizedCode;
   return `שער ${label} היציג הוא ${rate} ש״ח`;
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
