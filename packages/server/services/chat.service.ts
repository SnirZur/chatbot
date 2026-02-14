import path from 'path';
import { llmClient } from '../llm/client';
import {
   debugEnabled,
   logError,
   logBlock,
   logLine,
   logPhase,
   preview,
   safeJson,
} from '../logger';
import {
   analyzeReviewPrompt,
   generalChatPrompt,
   mathTranslatorPrompt,
   orchestrationSynthesisPrompt,
   ragGenerationPrompt,
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
let requestCounter = 0;

function nextRequestId(): string {
   requestCounter += 1;
   return `req-${String(requestCounter).padStart(3, '0')}`;
}

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

async function getWeather(city: string, reqId: string): Promise<string> {
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
   const startTime = Date.now();

   try {
      const url = new URL('https://api.openweathermap.org/data/2.5/weather');
      url.searchParams.set('q', normalizedCity);
      url.searchParams.set('appid', apiKey);
      url.searchParams.set('units', 'metric');
      url.searchParams.set('lang', 'he');

      const response = await fetch(url, { signal: controller.signal });
      logLine(
         reqId,
         `[HTTP] weather status=${response.status} duration=${Date.now() - startTime}ms city="${city}"`
      );
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

      if (char === '(') {
         operators.push(char);
         index += 1;
         continue;
      }

      if (char === ')') {
         while (
            operators.length > 0 &&
            operators[operators.length - 1] !== '('
         ) {
            applyOperator();
         }
         if (operators[operators.length - 1] === '(') {
            operators.pop();
         } else {
            return Number.NaN;
         }
         index += 1;
         continue;
      }

      // @ts-ignore
      if (!/[+\-*\/]/.test(char)) {
         return Number.NaN;
      }

      while (operators.length > 0) {
         const top = operators[operators.length - 1];
         if (top === '(') {
            break;
         }
         if (
            char &&
            /[+\-*\/]/.test(char) &&
            (precedence[top as string] ?? 0) >= (precedence[char] ?? 0)
         ) {
            applyOperator();
            continue;
         }
         break;
      }

      if (char) {
         operators.push(char);
      }
      index += 1;
   }

   while (operators.length > 0) {
      if (operators[operators.length - 1] === '(') {
         return Number.NaN;
      }
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

async function getProductInformation(
   productName: string,
   query: string,
   reqId: string
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
   const startTime = Date.now();

   try {
      logPhase(reqId, 'RAG');
      logLine(
         reqId,
         `[RAG] query="${preview(composedQuery)}" product="${preview(productName)}"`
      );
      logLine(reqId, '[RAG] calling python-service /search_kb');
      const response = await fetch(`${baseUrl}/search_kb`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ query: composedQuery }),
         signal: controller.signal,
      });

      logLine(
         reqId,
         `[RAG] http_status=${response.status} duration=${Date.now() - startTime}ms`
      );
      if (!response.ok) {
         throw new Error(`RAG service error: ${response.status}`);
      }

      const data = (await response.json()) as { chunks?: string[] };
      const chunks = Array.isArray(data.chunks) ? data.chunks : [];

      logLine(reqId, `[RAG] chunks_received=${chunks.length}`);
      if (debugEnabled()) {
         chunks.slice(0, 3).forEach((chunk, index) => {
            logLine(reqId, `[RAG.chunk${index + 1}] "${preview(chunk)}"`);
         });
      }
      logLine(
         reqId,
         '[RAG] Embeddings computed in python-service (not logged here)'
      );

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
      logBlock(reqId, '[RAG.context]', preview(ragPayload, 800));

      const generation = await llmClient.generateText({
         model: 'gpt-4o-mini',
         instructions: ragGenerationPrompt,
         prompt: ragPayload,
         temperature: 0.2,
         maxTokens: 220,
      });

      return generation.text.trim();
   } catch (error) {
      logError(
         reqId,
         `[RAG] ${error instanceof Error ? error.message : 'Unknown error'}`
      );
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

function normalizeExpression(expression: string): string {
   return expression
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/–/g, '-')
      .replace(/−/g, '-');
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

   const expression = normalizeExpression(
      response.text.trim().split('\n')[0]?.trim() ?? ''
   );
   if (!expression || !isExpressionClean(expression)) {
      return null;
   }

   console.log('Math translation expression:', expression);
   return expression;
}

type PlanResult = {
   plan: RouterPlan;
   rawText: string;
   durationMs: number;
};

async function classifyPlan(
   message: string,
   reqId: string
): Promise<PlanResult> {
   try {
      const startTime = Date.now();
      const response = await llmClient.generateText({
         model: 'gpt-4o-mini',
         instructions: routerPrompt,
         prompt: message,
         temperature: 0,
         maxTokens: 240,
         responseFormat: { type: 'json_object' },
      });

      const durationMs = Date.now() - startTime;
      const parsed = parseRouterPlan(response.text);
      if (!parsed) {
         return {
            plan: { plan: [], final_answer_synthesis_required: false },
            rawText: response.text,
            durationMs,
         };
      }

      return { plan: parsed, rawText: response.text, durationMs };
   } catch (error) {
      logError(
         reqId,
         `Planner failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return {
         plan: { plan: [], final_answer_synthesis_required: false },
         rawText: '',
         durationMs: 0,
      };
   }
}

async function routeMessage(
   history: Message[],
   userInput: string,
   _conversationId: string
): Promise<ChatResponse> {
   const reqId = nextRequestId();
   logLine(reqId, `[REQ] user="${preview(userInput)}"`);
   if (userInput.trim() === '/reset') {
      await resetHistory();
      return {
         id: crypto.randomUUID(),
         message: 'היסטוריית השיחה אופסה. נתחיל שיחה חדשה.',
      };
   }

   const planResult = await classifyPlan(userInput, reqId);
   logPhase(reqId, 'PLAN');
   const prettyPlan = (() => {
      try {
         return JSON.stringify(JSON.parse(planResult.rawText), null, 2);
      } catch {
         return planResult.rawText || '';
      }
   })();
   logBlock(reqId, '[PLAN.raw]', prettyPlan || '(empty)');
   logLine(
      reqId,
      `[PLAN] steps=${planResult.plan.plan.length} synth=${planResult.plan.final_answer_synthesis_required} duration=${planResult.durationMs}ms`
   );
   planResult.plan.plan.forEach((step, index) => {
      logLine(
         reqId,
         `Step ${index + 1}: tool=${step.tool} params=${safeJson(step.parameters)}`
      );
   });

   if (planResult.plan.plan.length === 0) {
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
      results: ToolResult[],
      reqId: string
   ): unknown => {
      if (typeof value === 'string') {
         return value.replace(/<result_from_tool_(\d+)>/g, (_match, index) => {
            const result = results[Number(index) - 1];
            if (!result) {
               return '';
            }
            logLine(
               reqId,
               `[SUBST] <result_from_tool_${index}> -> "${preview(
                  result.data ?? result.text
               )}"`
            );
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
         return value.map((item) => resolvePlaceholders(item, results, reqId));
      }

      if (value && typeof value === 'object') {
         const entries = Object.entries(value as Record<string, unknown>);
         const resolved: Record<string, unknown> = {};
         for (const [key, nested] of entries) {
            resolved[key] = resolvePlaceholders(nested, results, reqId);
         }
         return resolved;
      }

      return value;
   };

   const results: ToolResult[] = [];

   logPhase(reqId, 'EXECUTION');
   const totalSteps = planResult.plan.plan.length;

   for (const [index, step] of planResult.plan.plan.entries()) {
      const stepNumber = index + 1;
      const stepStart = Date.now();

      const resolvedParameters = resolvePlaceholders(
         step.parameters,
         results,
         reqId
      ) as Record<string, unknown>;

      logLine(
         reqId,
         `Executing step ${stepNumber}/${totalSteps}: tool=${step.tool} params=${safeJson(
            resolvedParameters
         )}`
      );

      try {
         if (step.tool === 'getWeather') {
            const city =
               typeof resolvedParameters.city === 'string'
                  ? resolvedParameters.city
                  : '';
            const weather = await getWeather(city, reqId);
            results.push({ tool: step.tool, text: weather, data: weather });
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="${preview(
                  weather
               )}" duration=${Date.now() - stepStart}ms`
            );
            continue;
         }

         if (step.tool === 'calculateMath') {
            const rawExpression =
               typeof resolvedParameters.expression === 'string'
                  ? resolvedParameters.expression
                  : '';
            let expression = normalizeExpression(rawExpression);

            if (!isExpressionClean(expression)) {
               const translated = await translateMathExpression(rawExpression);
               if (!translated) {
                  const fallback = 'לא הצלחתי לחשב את הביטוי שביקשת.';
                  results.push({
                     tool: step.tool,
                     text: fallback,
                  });
                  logError(
                     reqId,
                     `Step ${stepNumber} tool=${step.tool} failed: translation failed (fallback="${fallback}")`
                  );
                  logLine(
                     reqId,
                     `Step ${stepNumber}/${totalSteps} result="${preview(
                        fallback
                     )}" duration=${Date.now() - stepStart}ms`
                  );
                  continue;
               }
               expression = translated;
            }

            const result = calculateMath(expression);
            if (!Number.isFinite(result)) {
               const fallback = 'לא הצלחתי לחשב את הביטוי שביקשת.';
               results.push({
                  tool: step.tool,
                  text: fallback,
               });
               logError(
                  reqId,
                  `Step ${stepNumber} tool=${step.tool} failed: invalid result (fallback="${fallback}")`
               );
               logLine(
                  reqId,
                  `Step ${stepNumber}/${totalSteps} result="${preview(
                     fallback
                  )}" duration=${Date.now() - stepStart}ms`
               );
               continue;
            }

            const responseText = `התוצאה היא ${result}`;
            results.push({
               tool: step.tool,
               text: responseText,
               data: result,
            });
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="${preview(
                  responseText
               )}" duration=${Date.now() - stepStart}ms`
            );
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
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="${preview(
                  exchange.text
               )}" duration=${Date.now() - stepStart}ms`
            );
            continue;
         }

         if (step.tool === 'generalChat') {
            const message =
               typeof resolvedParameters.message === 'string'
                  ? resolvedParameters.message
                  : userInput;
            const response = await generalChat(history, message);
            results.push({ tool: step.tool, text: response, data: response });
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="${preview(
                  response
               )}" duration=${Date.now() - stepStart}ms`
            );
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
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="${preview(
                  response.text
               )}" duration=${Date.now() - stepStart}ms`
            );
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
            const response = await getProductInformation(
               productName,
               query,
               reqId
            );
            results.push({ tool: step.tool, text: response, data: response });
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="${preview(
                  response
               )}" duration=${Date.now() - stepStart}ms`
            );
            continue;
         }

         const fallback = 'הכלי שביקשת עדיין לא זמין.';
         results.push({
            tool: step.tool,
            text: fallback,
         });
         logError(
            reqId,
            `Step ${stepNumber} tool=${step.tool} failed: unknown tool (fallback="${fallback}")`
         );
         logLine(
            reqId,
            `Step ${stepNumber}/${totalSteps} result="${preview(
               fallback
            )}" duration=${Date.now() - stepStart}ms`
         );
      } catch (error) {
         const fallback = 'אירעה שגיאה במהלך ביצוע הפעולה.';
         results.push({ tool: step.tool, text: fallback });
         logError(
            reqId,
            `Step ${stepNumber} tool=${step.tool} error=${
               error instanceof Error ? error.message : 'Unknown error'
            } (fallback="${fallback}")`
         );
         logLine(
            reqId,
            `Step ${stepNumber}/${totalSteps} result="${preview(
               fallback
            )}" duration=${Date.now() - stepStart}ms`
         );
      }
   }

   if (results.length === 0) {
      return {
         id: crypto.randomUUID(),
         message: await generalChat(history, userInput),
      };
   }

   if (planResult.plan.final_answer_synthesis_required) {
      logPhase(reqId, 'SYNTHESIS');
      const isMathAndFxOnly = results.every(
         (result) =>
            result.tool === 'calculateMath' || result.tool === 'getExchangeRate'
      );
      const mathResult = results.find(
         (result) => result.tool === 'calculateMath'
      );

      if (isMathAndFxOnly && typeof mathResult?.data === 'number') {
         const exchangeText =
            results.find((result) => result.tool === 'getExchangeRate')?.text ??
            '';
         const numericValue = mathResult.data as number;
         const responseText = exchangeText
            ? `${exchangeText}. לפי החישוב, יישארו ${numericValue} ש״ח.`
            : `לפי החישוב, יישארו ${numericValue} ש״ח.`;
         logLine(reqId, '[SYNTH] deterministic_answer_used=true');
         return {
            id: crypto.randomUUID(),
            message: responseText,
         };
      }

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
      logLine(
         reqId,
         `[SYNTH] inputs=${results
            .map((_result, index) => `tool_${index + 1}_result`)
            .join(', ')}`
      );
      logLine(reqId, `[SYNTH] prompt_size_chars=${synthesisPayload.length}`);

      const synthStart = Date.now();
      const synthesis = await llmClient.generateText({
         model: 'gpt-4o-mini',
         instructions: orchestrationSynthesisPrompt,
         prompt: synthesisPayload,
         temperature: 0.2,
         maxTokens: 200,
      });
      logLine(reqId, `[SYNTH] duration=${Date.now() - synthStart}ms`);

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
