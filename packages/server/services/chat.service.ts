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

type ToolName =
   | 'getWeather'
   | 'calculateMath'
   | 'getExchangeRate'
   | 'generalChat'
   | 'getProductInformation'
   | 'analyzeReview';

type PlanStep = {
   tool: ToolName;
   parameters: Record<string, unknown>;
};

type RouterPlan = {
   plan: PlanStep[];
   final_answer_synthesis_required: boolean;
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
         (index === 0 ||
            (trimmed[index - 1] !== undefined &&
               /[+\-*/]/.test(trimmed[index - 1]!)));

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
      if (!/[+\-*\/]/.test(char)) {
         return Number.NaN;
      }

      while (
         operators.length > 0 &&
         char &&
         /[+\-*\/]/.test(char) &&
         (precedence[operators[operators.length - 1]!] ?? 0) >=
            (precedence[char] ?? 0)
      ) {
         applyOperator();
      }

      if (char) {
         operators.push(char);
      }
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

function getExchangeRate(
   from: string,
   to = 'ILS'
): {
   text: string;
   rate?: number;
} {
   const normalizedFrom = from.trim().toUpperCase();
   const normalizedTo = to.trim().toUpperCase() || 'ILS';
   if (!normalizedFrom) {
      return { text: 'לא מכיר את קוד המטבע שביקשת.' };
   }

   if (normalizedTo !== 'ILS') {
      return { text: 'כרגע אני תומך רק בשער מול ש״ח.' };
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
      return { text: 'לא מכיר את קוד המטבע שביקשת.' };
   }

   const label = labels[normalizedFrom] ?? normalizedFrom;
   return { text: `שער ${label} היציג הוא ${rate} ש״ח`, rate };
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

const ragGenerationPrompt =
   'You answer product questions using ONLY the provided knowledge chunks. If the answer is not explicitly supported, say you do not have enough information. Be concise, grounded, and avoid speculation. Return the answer in Hebrew.';

const orchestrationSynthesisPrompt =
   'You are a tool orchestration assistant. Combine the tool outputs into a single, concise response in Hebrew. Use only the provided tool results; do not add new facts.';

const analyzeReviewPrompt =
   'You analyze a short product review. Return: (1) sentiment label (positive/neutral/negative), (2) 2-3 key issues or praises. Keep it short and in Hebrew.';

async function getProductInformation(
   productName: string,
   query: string
): Promise<string> {
   const baseUrl =
      process.env.RAG_SERVICE_URL?.trim() || 'http://localhost:8000';
   const composedQuery = [productName, query]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(' - ');

   if (!composedQuery) {
      return 'לא הועברו פרטים מספיקים כדי לחפש מידע על המוצר.';
   }

   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), 8000);

   try {
      const response = await fetch(`${baseUrl}/search_kb`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ query: composedQuery }),
         signal: controller.signal,
      });

      if (!response.ok) {
         throw new Error(`RAG service error: ${response.status}`);
      }

      const data = (await response.json()) as { chunks?: string[] };
      const chunks = Array.isArray(data.chunks) ? data.chunks : [];

      if (chunks.length === 0) {
         return 'לא מצאתי מידע רלוונטי במאגר.';
      }

      const ragPayload = JSON.stringify(
         {
            product: productName,
            user_query: query,
            knowledge_chunks: chunks,
         },
         null,
         2
      );

      const generation = await llmClient.generateText({
         model: 'gpt-4o-mini',
         instructions: ragGenerationPrompt,
         prompt: ragPayload,
         temperature: 0.2,
         maxTokens: 220,
      });

      return generation.text.trim();
   } catch (error) {
      console.error(error);
      return 'לא הצלחתי להביא מידע על המוצר כרגע, נסה שוב מאוחר יותר.';
   } finally {
      clearTimeout(timeout);
   }
}

function extractJson(text: string): string | null {
   const match = text.match(/\{[\s\S]*\}/);
   return match ? match[0] : null;
}

function parseRouterPlan(text: string): RouterPlan | null {
   const candidate = extractJson(text) ?? text;
   try {
      const parsed = JSON.parse(candidate) as RouterPlan;
      if (
         !parsed ||
         !Array.isArray(parsed.plan) ||
         typeof parsed.final_answer_synthesis_required !== 'boolean'
      ) {
         return null;
      }

      const allowedTools = new Set<ToolName>([
         'getWeather',
         'calculateMath',
         'getExchangeRate',
         'generalChat',
         'getProductInformation',
         'analyzeReview',
      ]);

      const plan: PlanStep[] = [];
      for (const step of parsed.plan) {
         if (
            !step ||
            typeof step.tool !== 'string' ||
            !allowedTools.has(step.tool as ToolName) ||
            typeof step.parameters !== 'object' ||
            step.parameters === null ||
            Array.isArray(step.parameters)
         ) {
            return null;
         }
         plan.push({
            tool: step.tool as ToolName,
            parameters: step.parameters as Record<string, unknown>,
         });
      }

      return {
         plan,
         final_answer_synthesis_required:
            parsed.final_answer_synthesis_required,
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

async function classifyPlan(message: string): Promise<RouterPlan> {
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
      const parsed = parseRouterPlan(response.text);
      if (parsed) {
         console.log('Router parsed JSON:', JSON.stringify(parsed, null, 2));
      }
      if (!parsed) {
         return { plan: [], final_answer_synthesis_required: false };
      }

      return parsed;
   } catch (error) {
      console.error('Classifier failed:', error);
      return { plan: [], final_answer_synthesis_required: false };
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

   const planResult = await classifyPlan(userInput);

   if (planResult.plan.length === 0) {
      return {
         id: crypto.randomUUID(),
         message: await generalChat(history, userInput),
      };
   }

   type ToolResult = {
      tool: ToolName;
      text: string;
      data?: string | number;
   };

   const resolvePlaceholders = (
      value: unknown,
      results: ToolResult[]
   ): unknown => {
      if (typeof value === 'string') {
         return value.replace(/<result_from_tool_(\d+)>/g, (_match, index) => {
            const result = results[Number(index) - 1];
            if (!result) {
               return '';
            }
            if (typeof result.data === 'number') {
               return String(result.data);
            }
            if (typeof result.data === 'string') {
               return result.data;
            }
            return result.text;
         });
      }

      if (Array.isArray(value)) {
         return value.map((item) => resolvePlaceholders(item, results));
      }

      if (value && typeof value === 'object') {
         const entries = Object.entries(value as Record<string, unknown>);
         const resolved: Record<string, unknown> = {};
         for (const [key, nested] of entries) {
            resolved[key] = resolvePlaceholders(nested, results);
         }
         return resolved;
      }

      return value;
   };

   const results: ToolResult[] = [];

   for (const step of planResult.plan) {
      const resolvedParameters = resolvePlaceholders(
         step.parameters,
         results
      ) as Record<string, unknown>;

      if (step.tool === 'getWeather') {
         const city =
            typeof resolvedParameters.city === 'string'
               ? resolvedParameters.city
               : '';
         const weather = await getWeather(city);
         results.push({ tool: step.tool, text: weather, data: weather });
         continue;
      }

      if (step.tool === 'calculateMath') {
         const rawExpression =
            typeof resolvedParameters.expression === 'string'
               ? resolvedParameters.expression
               : '';
         let expression = rawExpression;

         if (!isExpressionClean(expression)) {
            const translated = await translateMathExpression(rawExpression);
            if (!translated) {
               results.push({
                  tool: step.tool,
                  text: 'לא הצלחתי לחשב את הביטוי שביקשת.',
               });
               continue;
            }
            expression = translated;
         }

         const result = calculateMath(expression);
         if (!Number.isFinite(result)) {
            results.push({
               tool: step.tool,
               text: 'לא הצלחתי לחשב את הביטוי שביקשת.',
            });
            continue;
         }

         results.push({
            tool: step.tool,
            text: `התוצאה היא ${result}`,
            data: result,
         });
         continue;
      }

      if (step.tool === 'getExchangeRate') {
         const from =
            typeof resolvedParameters.from === 'string'
               ? resolvedParameters.from
               : '';
         const to =
            typeof resolvedParameters.to === 'string'
               ? resolvedParameters.to
               : 'ILS';
         const exchange = getExchangeRate(from, to);
         results.push({
            tool: step.tool,
            text: exchange.text,
            data: exchange.rate ?? exchange.text,
         });
         continue;
      }

      if (step.tool === 'generalChat') {
         const message =
            typeof resolvedParameters.message === 'string'
               ? resolvedParameters.message
               : userInput;
         const response = await generalChat(history, message);
         results.push({ tool: step.tool, text: response, data: response });
         continue;
      }

      if (step.tool === 'analyzeReview') {
         const reviewText =
            typeof resolvedParameters.review_text === 'string'
               ? resolvedParameters.review_text
               : '';
         const response = await llmClient.generateText({
            model: 'gpt-4o-mini',
            instructions: analyzeReviewPrompt,
            prompt: reviewText,
            temperature: 0.2,
            maxTokens: 120,
         });
         results.push({
            tool: step.tool,
            text: response.text,
            data: response.text,
         });
         continue;
      }

      if (step.tool === 'getProductInformation') {
         const productName =
            typeof resolvedParameters.product_name === 'string'
               ? resolvedParameters.product_name
               : '';
         const query =
            typeof resolvedParameters.query === 'string'
               ? resolvedParameters.query
               : '';
         const response = await getProductInformation(productName, query);
         results.push({ tool: step.tool, text: response, data: response });
         continue;
      }

      results.push({
         tool: step.tool,
         text: 'הכלי שביקשת עדיין לא זמין.',
      });
   }

   if (results.length === 0) {
      return {
         id: crypto.randomUUID(),
         message: await generalChat(history, userInput),
      };
   }

   if (planResult.final_answer_synthesis_required) {
      const synthesisPayload = JSON.stringify(
         {
            user_request: userInput,
            tool_results: results.map((result, index) => ({
               step: index + 1,
               tool: result.tool,
               output: result.text,
            })),
         },
         null,
         2
      );

      const synthesis = await llmClient.generateText({
         model: 'gpt-4o-mini',
         instructions: orchestrationSynthesisPrompt,
         prompt: synthesisPayload,
         temperature: 0.2,
         maxTokens: 200,
      });

      return {
         id: crypto.randomUUID(),
         message: synthesis.text,
      };
   }

   return {
      id: crypto.randomUUID(),
      message: results[results.length - 1]?.text ?? 'לא הצלחתי להשיב.',
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
