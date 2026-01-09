import path from 'path';
import { llmClient } from '../llm/client';

const genericInstructions =
   "You are a helpful assistant. Answer the user's question accurately and concisely. Do not limit your responses to any specific product, brand, or domain unless the user asks for that context. If you are unsure, state that you don't know rather than fabricating an answer.";
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

type Intent = 'weather' | 'math' | 'exchange_rate' | 'general';

type IntentResult = {
   intent: Intent;
   city?: string;
   expression?: string;
   currencyCode?: string;
};

const classifierInstructions =
   `אתה מסווג כוונות לשירות צ'אט. תפקידך היחיד הוא להחזיר JSON תקין בלבד.
החזֵר בדיוק אובייקט JSON אחד ללא טקסט נוסף, ללא עטיפות קוד וללא הסברים.

קטגוריות אפשריות (חובה לבחור אחת בדיוק):
- "weather": בקשה למזג אוויר. החזר גם "city".
- "math": חישוב ביטוי מתמטי. החזר גם "expression".
- "exchange_rate": בקשה לשער חליפין. החזר גם "currencyCode" (קוד מטבע באנגלית, למשל USD או EUR).
- "general": כל דבר אחר.

דוגמאות:
{"intent":"weather","city":"חיפה"}
{"intent":"math","expression":"150 + 20"}
{"intent":"exchange_rate","currencyCode":"USD"}
{"intent":"general"}`.trim();

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
   context: Message[],
   userInput: string
): Promise<string> {
   const messages: Message[] = [
      { role: 'system', content: genericInstructions },
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

function extractJson(text: string): IntentResult | null {
   const match = text.match(/\{[\s\S]*\}/);
   if (!match) {
      return null;
   }

   try {
      return JSON.parse(match[0]) as IntentResult;
   } catch (error) {
      console.error('Failed to parse classifier JSON:', error);
      return null;
   }
}

async function classifyIntent(message: string): Promise<IntentResult> {
   try {
      const response = await llmClient.generateText({
         model: 'gpt-4o-mini',
         instructions: classifierInstructions,
         prompt: message,
         temperature: 0,
         maxTokens: 120,
      });

      const parsed = extractJson(response.text);
      if (!parsed || typeof parsed.intent !== 'string') {
         return { intent: 'general' };
      }

      const intent = parsed.intent as Intent;
      if (
         intent !== 'weather' &&
         intent !== 'math' &&
         intent !== 'exchange_rate' &&
         intent !== 'general'
      ) {
         return { intent: 'general' };
      }

      return {
         intent,
         city: parsed.city,
         expression: parsed.expression,
         currencyCode: parsed.currencyCode,
      };
   } catch (error) {
      console.error('Classifier failed:', error);
      return { intent: 'general' };
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
