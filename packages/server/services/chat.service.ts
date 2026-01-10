import path from 'path';
import { llmClient } from '../llm/client';
import {
   generalChatPrompt,
   mathTranslatorPrompt,
   routerPrompt,
} from './prompts';
const historyFilePath = path.resolve(
   import.meta.dir,
   '..',
   '..',
   '..',
   'history.json'
);

const history: Message[] = [];
const historyWelcomeMessage = 'ברוך שובך! טענתי את היסטוריית השיחה הקודמת.';
let hasPersistedHistory = false;

async function loadHistory() {
   try {
      const file = Bun.file(historyFilePath);
      if (await file.exists()) {
         const text = await file.text();
         const parsed = JSON.parse(text);
         if (Array.isArray(parsed)) {
            for (const item of parsed) {
               if (
                  item &&
                  (item.role === 'user' ||
                     item.role === 'assistant' ||
                     item.role === 'system') &&
                  typeof item.content === 'string'
               ) {
                  history.push({ role: item.role, content: item.content });
               }
            }
         }
         hasPersistedHistory = history.length > 0;
      }
   } catch (error) {
      console.error('Failed to load history:', error);
   }
}

async function saveHistory() {
   try {
      await Bun.write(historyFilePath, JSON.stringify(history, null, 2));
      hasPersistedHistory = history.length > 0;
   } catch (error) {
      console.error('Failed to save history:', error);
   }
}

async function resetHistory() {
   history.length = 0;
   hasPersistedHistory = false;
   try {
      await Bun.write(historyFilePath, JSON.stringify(history, null, 2));
   } catch (error) {
      console.error('Failed to reset history:', error);
   }
}

type ChatResponse = {
   id: string;
   message: string;
};

type MessageRole = 'user' | 'assistant' | 'system';

type Message = {
   role: MessageRole;
   content: string;
};

type Intent = 'getWeather' | 'calculateMath' | 'getExchangeRate' | 'general';

type RouterResult = {
   intent: Intent;
   parameters: Record<string, unknown>;
   confidence: number;
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
      // @ts-ignore
      const temp = Number(data?.main?.temp);
      // @ts-ignore
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
      // @ts-ignore
      // @ts-ignore
      // @ts-ignore
      // @ts-ignore
      const isUnarySign =
         (char === '+' || char === '-') &&
         (index === 0 || /[+\-*/]/.test(trimmed[index - 1]));

      // @ts-ignore
      if (/\d|\./.test(char) || isUnarySign) {
         let start = index;
         index += 1;
         // @ts-ignore
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

      // @ts-ignore
      if (!/[+\-*/]/.test(char)) {
         return Number.NaN;
      }

      // @ts-ignore
      while (
         operators.length > 0 &&
         precedence[operators[operators.length - 1]] >= precedence[char]
      ) {
         applyOperator();
      }

      // @ts-ignore
      operators.push(char);
      index += 1;
   }

   while (operators.length > 0) {
      applyOperator();
   }

   if (values.length !== 1 || !Number.isFinite(values[0])) {
      return Number.NaN;
   }

   // @ts-ignore
   return values[0];
}

function getExchangeRate(from: string, to = 'ILS'): string {
   const normalizedFrom = from.trim().toUpperCase();
   const normalizedTo = to.trim().toUpperCase() || 'ILS';
   if (!normalizedFrom) {
      return 'לא מכיר את קוד המטבע שביקשת.';
   }

   if (normalizedTo !== 'ILS') {
      return 'כרגע אני תומך רק בשער מול ש״ח.';
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

   const rate = rates[normalizedFrom];
   if (!rate) {
      return 'לא מכיר את קוד המטבע שביקשת.';
   }

   const label = labels[normalizedFrom] ?? normalizedFrom;
   return `שער ${label} היציג הוא ${rate} ש״ח`;
}

async function generalChat(
   context: Message[],
   userInput: string
): Promise<string> {
   const messages: Message[] = [
      { role: 'system', content: generalChatPrompt },
      ...context,
      { role: 'user', content: userInput },
   ];

   const response = await llmClient.chatCompletion({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.2,
      maxTokens: 200,
   });

   return response.text;
}

function extractJson(text: string): string | null {
   const match = text.match(/\{[\s\S]*\}/);
   return match ? match[0] : null;
}

function parseRouterResult(text: string): RouterResult | null {
   const candidate = extractJson(text) ?? text;
   try {
      const parsed = JSON.parse(candidate) as RouterResult;
      if (
         !parsed ||
         typeof parsed.intent !== 'string' ||
         typeof parsed.confidence !== 'number' ||
         parsed.confidence < 0 ||
         parsed.confidence > 1 ||
         typeof parsed.parameters !== 'object' ||
         parsed.parameters === null
      ) {
         return null;
      }

      const intent = parsed.intent as Intent;
      if (
         intent !== 'getWeather' &&
         intent !== 'calculateMath' &&
         intent !== 'getExchangeRate' &&
         intent !== 'general'
      ) {
         return null;
      }

      return {
         intent,
         parameters: parsed.parameters,
         confidence: parsed.confidence,
      };
   } catch (error) {
      console.error('Failed to parse router JSON:', error);
      return null;
   }
}

function isExpressionClean(expression: string): boolean {
   return /^[\d+\-*/().\s]+$/.test(expression);
}

async function translateMathExpression(
   problem: string
): Promise<string | null> {
   const response = await llmClient.generateText({
      model: 'gpt-4o-mini',
      instructions: mathTranslatorPrompt,
      prompt: problem,
      temperature: 0,
      maxTokens: 60,
   });

   const expression = response.text.trim().split('\n')[0]?.trim();
   if (!expression || !isExpressionClean(expression)) {
      return null;
   }

   console.log('Math translation expression:', expression);
   return expression;
}

async function classifyIntent(message: string): Promise<RouterResult> {
   try {
      const response = await llmClient.generateText({
         model: 'gpt-4o-mini',
         instructions: routerPrompt,
         prompt: message,
         temperature: 0,
         maxTokens: 240,
         responseFormat: { type: 'json_object' },
      });

      console.log('Router raw JSON:', response.text);
      const parsed = parseRouterResult(response.text);
      if (parsed) {
         console.log('Router parsed JSON:', JSON.stringify(parsed, null, 2));
      }
      if (!parsed) {
         return { intent: 'general', parameters: {}, confidence: 0 };
      }

      return parsed;
   } catch (error) {
      console.error('Classifier failed:', error);
      return { intent: 'general', parameters: {}, confidence: 0 };
   }
}

async function routeMessage(
   history: Message[],
   userInput: string,
   _conversationId: string
): Promise<ChatResponse> {
   if (userInput.trim() === '/reset') {
      await resetHistory();
      return {
         id: crypto.randomUUID(),
         message: 'היסטוריית השיחה אופסה. נתחיל שיחה חדשה.',
      };
   }

   const classification = await classifyIntent(userInput);

   if (classification.confidence < 0.5) {
      return {
         id: crypto.randomUUID(),
         message: await generalChat(history, userInput),
      };
   }

   if (classification.intent === 'getWeather') {
      const city =
         typeof classification.parameters.city === 'string'
            ? classification.parameters.city
            : '';
      return {
         id: crypto.randomUUID(),
         message: await getWeather(city),
      };
   }

   if (classification.intent === 'calculateMath') {
      const inputNeedsTranslation = !isExpressionClean(userInput);
      const rawExpression =
         typeof classification.parameters.expression === 'string'
            ? classification.parameters.expression
            : userInput;
      let expression = rawExpression;

      if (inputNeedsTranslation) {
         const translated = await translateMathExpression(userInput);
         if (!translated) {
            return {
               id: crypto.randomUUID(),
               message: 'לא הצלחתי לחשב את הביטוי שביקשת.',
            };
         }
         expression = translated;
      }

      const result = calculateMath(expression);
      return {
         id: crypto.randomUUID(),
         message: Number.isFinite(result)
            ? `התוצאה היא ${result}`
            : 'לא הצלחתי לחשב את הביטוי שביקשת.',
      };
   }

   if (classification.intent === 'getExchangeRate') {
      const from =
         typeof classification.parameters.from === 'string'
            ? classification.parameters.from
            : '';
      const to =
         typeof classification.parameters.to === 'string'
            ? classification.parameters.to
            : 'ILS';
      return {
         id: crypto.randomUUID(),
         message: getExchangeRate(from, to),
      };
   }

   return {
      id: crypto.randomUUID(),
      message: await generalChat(history, userInput),
   };
}

// Public interface
export const chatService = {
   getHistoryStatus() {
      return {
         hasHistory: hasPersistedHistory,
         message: hasPersistedHistory ? historyWelcomeMessage : '',
      };
   },
   async sendMessage(
      prompt: string,
      conversationId: string
   ): Promise<ChatResponse> {
      const response = await routeMessage(history, prompt, conversationId);

      if (prompt.trim() !== '/reset') {
         history.push({ role: 'user', content: prompt });
         history.push({ role: 'assistant', content: response.message });
         await saveHistory();
      }

      return response;
   },
};

await loadHistory();
