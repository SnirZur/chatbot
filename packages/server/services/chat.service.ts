import path from 'path';
import z from 'zod';
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
   | 'analyzeReview'
   | 'reviewSentiment'
   | 'reviewAnalysis';

type PlanStep = {
   tool: ToolName;
   parameters: Record<string, unknown>;
};

type RouterPlan = {
   plan: PlanStep[];
   final_answer_synthesis_required: boolean;
};

const toolNameSchema = z.enum([
   'getWeather',
   'calculateMath',
   'getExchangeRate',
   'generalChat',
   'getProductInformation',
   'analyzeReview',
   'reviewSentiment',
   'reviewAnalysis',
]);

const routerPlanSchema = z.object({
   plan: z.array(
      z.object({
         tool: toolNameSchema,
         parameters: z.record(z.unknown()),
      })
   ),
   final_answer_synthesis_required: z.boolean(),
});

const reviewSentimentPrompt = `Analyze the sentiment of the following review. Respond with a JSON object: { "score": number (0-1), "sentiment": "positive" | "neutral" | "negative" }`;
const reviewAnalysisPrompt = `Analyze the following review and provide a score (0-1) and a short summary. Respond with a JSON object: { "score": number (0-1), "summary": string }`;

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

   const getPrec = (op?: string): number =>
      op && op in precedence ? precedence[op]! : 0;

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
      const char = trimmed.charAt(index);
      const prevChar = trimmed.charAt(index - 1);
      const isUnarySign =
         (char === '+' || char === '-') &&
         (index === 0 || /[+\-*/]/.test(prevChar));

      if (/\d|\./.test(char) || isUnarySign) {
         let start = index;
         index += 1;
         while (index < trimmed.length && /[\d.]/.test(trimmed.charAt(index))) {
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
         getPrec(operators[operators.length - 1]) >= getPrec(char)
      ) {
         applyOperator();
      }

      operators.push(char);
      index += 1;
   }

   while (operators.length > 0) {
      applyOperator();
   }

   const final = values[0];
   if (values.length !== 1 || !Number.isFinite(final as number)) {
      return Number.NaN;
   }

   return final as number;
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

   const response = await llmClient.chatCompletionOllama({
      model: 'llama3',
      messages,
   });

   return response.text;
}

async function getProductInformation(
   productName: string,
   query: string,
   reqId: string
): Promise<{ text: string; searchMs: number; generationMs: number }> {
   const baseUrl =
      process.env.RAG_SERVICE_URL?.trim() || 'http://localhost:8000';
   logLine(reqId, `[RAG Retrieval] baseUrl=${baseUrl}`);
   const composedQuery = [productName, query]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(' - ');

   if (!composedQuery) {
      return {
         text: 'לא הועברו פרטים מספיקים כדי לחפש מידע על המוצר.',
         searchMs: 0,
         generationMs: 0,
      };
   }

   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), 8000);
   const startTime = Date.now();
   let searchMs = 0;
   let generationMs = 0;

   try {
      logPhase(reqId, 'RAG');
      logLine(
         reqId,
         `[RAG Retrieval] query="${preview(composedQuery)}" product="${preview(productName)}"`
      );
      const searchStart = Date.now();
      const response = await fetch(`${baseUrl}/search_kb`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ query: composedQuery }),
         signal: controller.signal,
      });
      searchMs = Date.now() - searchStart;
      logLine(reqId, `[RAG Retrieval] duration_ms=${searchMs}`);
      logLine(reqId, `[RAG Retrieval] http_status=${response.status}`);

      if (!response.ok) {
         throw new Error(`RAG service error: ${response.status}`);
      }

      const data = (await response.json()) as { chunks?: string[] };
      const chunks = Array.isArray(data.chunks) ? data.chunks : [];

      logLine(reqId, `[RAG Retrieval] chunks_received=${chunks.length}`);

      if (chunks.length === 0) {
         return {
            text: 'לא מצאתי מידע רלוונטי במאגר.',
            searchMs,
            generationMs: 0,
         };
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

      const ragGenStart = Date.now();
      const generation = await llmClient.generateText({
         model: 'gpt-4o-mini',
         instructions: ragGenerationPrompt,
         prompt: ragPayload,
         temperature: 0.2,
         maxTokens: 220,
      });
      generationMs = Date.now() - ragGenStart;
      logLine(reqId, `[RAG Generation] duration_ms=${generationMs}`);

      return {
         text: generation.text.trim(),
         searchMs,
         generationMs,
      };
   } catch (error) {
      logError(
         reqId,
         `[RAG] ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return {
         text: 'לא הצלחתי להביא מידע על המוצר כרגע, נסה שוב מאוחר יותר.',
         searchMs,
         generationMs,
      };
   } finally {
      clearTimeout(timeout);
   }
}

async function reviewSentiment(
   reviewText: string,
   reqId: string
): Promise<{ score: number; sentiment: string; durationMs: number }> {
   const start = Date.now();
   const response = await llmClient.generateText({
      model: 'gpt-4o-mini',
      instructions: reviewSentimentPrompt,
      prompt: reviewText,
      temperature: 0.2,
      maxTokens: 60,
   });
   const durationMs = Date.now() - start;
   let score = 0;
   let sentiment = 'neutral';
   try {
      const parsed = JSON.parse(response.text);
      score = typeof parsed.score === 'number' ? parsed.score : 0;
      sentiment =
         typeof parsed.sentiment === 'string' ? parsed.sentiment : 'neutral';
   } catch {}
   logLine(
      reqId,
      `[ReviewSentiment] duration_ms=${durationMs} score=${score} sentiment=${sentiment}`
   );
   return { score, sentiment, durationMs };
}

async function reviewAnalysis(
   reviewText: string,
   reqId: string
): Promise<{ score: number; summary: string; durationMs: number }> {
   const start = Date.now();
   const response = await llmClient.generateText({
      model: 'gpt-4o-mini',
      instructions: reviewAnalysisPrompt,
      prompt: reviewText,
      temperature: 0.2,
      maxTokens: 80,
   });
   const durationMs = Date.now() - start;
   let score = 0;
   let summary = '';
   try {
      const parsed = JSON.parse(response.text);
      score = typeof parsed.score === 'number' ? parsed.score : 0;
      summary = typeof parsed.summary === 'string' ? parsed.summary : '';
   } catch {}
   logLine(
      reqId,
      `[ReviewAnalysis] duration_ms=${durationMs} score=${score} summary="${summary}"`
   );
   return { score, summary, durationMs };
}

function extractJson(text: string): string | null {
   if (!text) return null;
   const start = text.indexOf('{');
   if (start === -1) return null;

   let depth = 0;
   for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      if (depth === 0) {
         return text.slice(start, i + 1);
      }
   }
   // No balanced JSON object found
   return null;
}

function parseRouterPlan(text: string): RouterPlan | null {
   const raw = extractJson(text) ?? text;
   const candidate = typeof raw === 'string' ? raw.trim() : '';

   // Only attempt to parse if it looks like a JSON object with balanced braces
   if (!candidate || !candidate.startsWith('{') || !candidate.endsWith('}')) {
      return null;
   }

   try {
      const parsed = JSON.parse(candidate);
      const validation = routerPlanSchema.safeParse(parsed);
      if (!validation.success) {
         return null;
      }
      return validation.data as RouterPlan;
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
      let ollamaResponse = { id: '', text: '' };
      try {
         ollamaResponse = await llmClient.chatCompletionOllama({
            model: 'llama3',
            messages: [
               { role: 'system', content: routerPrompt },
               { role: 'user', content: message },
            ],
         });
      } catch (err) {
         logLine(
            reqId,
            `[PLAN] ollama call failed, will attempt OpenAI fallback: ${
               err instanceof Error ? err.message : 'Unknown error'
            }`
         );
      }

      let parsed = parseRouterPlan(ollamaResponse.text);
      let rawText = ollamaResponse.text;
      const isLowConfidence = !parsed || parsed.plan.length === 0;

      if (isLowConfidence) {
         logLine(
            reqId,
            '[PLAN] ollama parse failed or empty plan, falling back to openai'
         );
         const response = await llmClient.generateText({
            model: 'gpt-4o-mini',
            instructions: routerPrompt,
            prompt: message,
            temperature: 0,
            maxTokens: 240,
            responseFormat: { type: 'json_object' },
         });
         rawText = response.text;
         parsed = parseRouterPlan(rawText);
      }
      const durationMs = Date.now() - startTime;
      if (!parsed) {
         return {
            plan: { plan: [], final_answer_synthesis_required: false },
            rawText,
            durationMs,
         };
      }

      return { plan: parsed, rawText, durationMs };
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
   const requestStart = Date.now();
   const reqId = nextRequestId();
   const timings: {
      routingMs: number;
      synthesisMs: number;
      totalMs: number;
      generalChatMs: number;
      steps: Array<{ tool: ToolName; durationMs: number }>;
      rag: Array<{ searchMs: number; generationMs: number }>;
   } = {
      routingMs: 0,
      synthesisMs: 0,
      totalMs: 0,
      generalChatMs: 0,
      steps: [],
      rag: [],
   };

   const finalize = (message: string): ChatResponse => {
      timings.totalMs = Date.now() - requestStart;
      logPhase(reqId, 'SUMMARY');
      // Calculate total RAG durations
      const totalRagRetrieval = timings.rag.reduce(
         (sum, rag) => sum + (rag.searchMs || 0),
         0
      );
      const totalRagGeneration = timings.rag.reduce(
         (sum, rag) => sum + (rag.generationMs || 0),
         0
      );
      // Calculate total review durations
      const totalReviewSentiment = timings.steps
         .filter((step) => step.tool === 'reviewSentiment')
         .reduce((sum, step) => sum + (step.durationMs || 0), 0);
      const totalReviewAnalysis = timings.steps
         .filter((step) => step.tool === 'reviewAnalysis')
         .reduce((sum, step) => sum + (step.durationMs || 0), 0);
      logLine(
         reqId,
         `[SUMMARY] total=${timings.totalMs}ms routing=${timings.routingMs}ms synthesis=${timings.synthesisMs}ms general_chat=${timings.generalChatMs}ms rag_retrieval=${totalRagRetrieval}ms rag_generation=${totalRagGeneration}ms review_sentiment=${totalReviewSentiment}ms review_analysis=${totalReviewAnalysis}ms`
      );
      if (timings.steps.length > 0) {
         logLine(
            reqId,
            `[SUMMARY] steps=${timings.steps
               .map(
                  (step, index) =>
                     `${index + 1}:${step.tool}=${step.durationMs}ms`
               )
               .join(', ')}`
         );
      }
      if (timings.rag.length > 0) {
         logLine(
            reqId,
            `[SUMMARY] rag=${timings.rag
               .map(
                  (rag, index) =>
                     `${index + 1}:search=${rag.searchMs}ms gen=${rag.generationMs}ms`
               )
               .join(', ')}`
         );
      }
      return {
         id: crypto.randomUUID(),
         message,
      };
   };

   logLine(reqId, `[REQ] user="${preview(userInput)}"`);
   if (userInput.trim() === '/reset') {
      await resetHistory();
      return finalize('היסטוריית השיחה אופסה. נתחיל שיחה חדשה.');
   }

   // Auto-run review sentiment/analysis if input contains 'review' or similar
   const reviewKeywords = ['review', 'ביקורת', 'חוות דעת', 'דעה'];
   const productHints = [
      'evophone',
      'brewmaster',
      'printforge',
      'voltrider',
      'מפרט',
      'spec',
      'specs',
      'לפי מפרט',
      'לפי המפרט',
   ];
   const lowerInput = userInput.toLowerCase();
   const shouldRunReview =
      reviewKeywords.some((word) => lowerInput.includes(word)) &&
      !productHints.some((hint) => lowerInput.includes(hint));

   if (shouldRunReview) {
      // Review Sentiment
      const sentimentStart = Date.now();
      const sentimentResp = await llmClient.generateText({
         model: 'gpt-4o-mini',
         instructions: reviewSentimentPrompt,
         prompt: userInput,
         temperature: 0.2,
         maxTokens: 60,
      });
      const sentimentDuration = Date.now() - sentimentStart;
      let sentimentScore = 0;
      let sentimentLabel = 'neutral';
      try {
         const parsed = JSON.parse(sentimentResp.text);
         sentimentScore = typeof parsed.score === 'number' ? parsed.score : 0;
         sentimentLabel =
            typeof parsed.sentiment === 'string' ? parsed.sentiment : 'neutral';
      } catch {}
      logLine(
         reqId,
         `[ReviewSentiment] duration_ms=${sentimentDuration} score=${sentimentScore} sentiment=${sentimentLabel}`
      );

      // Review Analysis
      const analysisStart = Date.now();
      const analysisResp = await llmClient.generateText({
         model: 'gpt-4o-mini',
         instructions: reviewAnalysisPrompt,
         prompt: userInput,
         temperature: 0.2,
         maxTokens: 80,
      });
      const analysisDuration = Date.now() - analysisStart;
      let analysisScore = 0;
      let analysisSummary = '';
      try {
         const parsed = JSON.parse(analysisResp.text);
         analysisScore = typeof parsed.score === 'number' ? parsed.score : 0;
         analysisSummary =
            typeof parsed.summary === 'string' ? parsed.summary : '';
      } catch {}
      logLine(
         reqId,
         `[ReviewAnalysis] duration_ms=${analysisDuration} score=${analysisScore} summary="${analysisSummary}"`
      );

      // Add to summary durations
      timings.steps.push({
         tool: 'reviewSentiment',
         durationMs: sentimentDuration,
      });
      timings.steps.push({
         tool: 'reviewAnalysis',
         durationMs: analysisDuration,
      });

      // Compose response
      return finalize(
         `Review Sentiment: ${sentimentLabel} (score: ${sentimentScore})\nReview Analysis: ${analysisSummary} (score: ${analysisScore})`
      );
   }

   const planResult = await classifyPlan(userInput, reqId);
   timings.routingMs = planResult.durationMs;
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
      const generalStart = Date.now();
      const response = await generalChat(history, userInput);
      timings.generalChatMs = Date.now() - generalStart;
      return finalize(response);
   }

   type ToolResult = {
      tool: ToolName;
      text: string;
      data?: string | number;
   };

   const extractNumericValue = (result: ToolResult): string | null => {
      if (typeof result.data === 'number' && Number.isFinite(result.data)) {
         return String(result.data);
      }
      if (typeof result.data === 'string') {
         const match = result.data.match(/-?\d+(?:\.\d+)?/);
         if (match) return match[0];
      }
      if (typeof result.text === 'string') {
         const match = result.text.match(/-?\d+(?:\.\d+)?/);
         if (match) return match[0];
      }
      return null;
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

   const resolvePlaceholdersNumeric = (
      value: string,
      results: ToolResult[],
      reqId: string
   ): string =>
      value.replace(/<result_from_tool_(\d+)>/g, (_match, index) => {
         const result = results[Number(index) - 1];
         if (!result) return '';
         const numeric = extractNumericValue(result);
         logLine(
            reqId,
            `[SUBST.numeric] <result_from_tool_${index}> -> "${preview(
               numeric ?? ''
            )}"`
         );
         return numeric ?? '';
      });

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

      if (step.tool === 'calculateMath') {
         const rawExpression =
            typeof step.parameters.expression === 'string'
               ? step.parameters.expression
               : '';
         resolvedParameters.expression = resolvePlaceholdersNumeric(
            rawExpression,
            results,
            reqId
         );
      }

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
            timings.steps.push({
               tool: step.tool,
               durationMs: Date.now() - stepStart,
            });
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
                  timings.steps.push({
                     tool: step.tool,
                     durationMs: Date.now() - stepStart,
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
               timings.steps.push({
                  tool: step.tool,
                  durationMs: Date.now() - stepStart,
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
            timings.steps.push({
               tool: step.tool,
               durationMs: Date.now() - stepStart,
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
            timings.steps.push({
               tool: step.tool,
               durationMs: Date.now() - stepStart,
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
            const generalStart = Date.now();
            const response = await generalChat(history, message);
            timings.generalChatMs += Date.now() - generalStart;
            results.push({ tool: step.tool, text: response, data: response });
            timings.steps.push({
               tool: step.tool,
               durationMs: Date.now() - stepStart,
            });
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="${preview(
                  response
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
            results.push({
               tool: step.tool,
               text: response.text,
               data: response.text,
            });
            timings.steps.push({
               tool: step.tool,
               durationMs: Date.now() - stepStart,
            });
            timings.rag.push({
               searchMs: response.searchMs,
               generationMs: response.generationMs,
            });
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="${preview(response.text)}" duration=${Date.now() - stepStart}ms`
            );
            continue;
         }

         if (step.tool === 'analyzeReview') {
            const reviewText =
               typeof resolvedParameters.review_text === 'string'
                  ? resolvedParameters.review_text
                  : '';
            const reviewStart = Date.now();
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
            timings.steps.push({
               tool: step.tool,
               durationMs: Date.now() - reviewStart,
            });
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="${preview(
                  response.text
               )}" duration=${Date.now() - stepStart}ms`
            );
            continue;
         }

         if (step.tool === 'reviewSentiment') {
            const reviewText =
               typeof resolvedParameters.review_text === 'string'
                  ? resolvedParameters.review_text
                  : '';
            const start = Date.now();
            const response = await llmClient.generateText({
               model: 'gpt-4o-mini',
               instructions: reviewSentimentPrompt,
               prompt: reviewText,
               temperature: 0.2,
               maxTokens: 60,
            });
            const durationMs = Date.now() - start;
            let score = 0;
            let sentiment = 'neutral';
            try {
               const parsed = JSON.parse(response.text);
               score = typeof parsed.score === 'number' ? parsed.score : 0;
               sentiment =
                  typeof parsed.sentiment === 'string'
                     ? parsed.sentiment
                     : 'neutral';
            } catch {}
            logLine(
               reqId,
               `[ReviewSentiment] duration_ms=${durationMs} score=${score} sentiment=${sentiment}`
            );
            results.push({
               tool: step.tool,
               text: `Sentiment: ${sentiment}, Score: ${score}`,
               data: score,
            });
            timings.steps.push({ tool: step.tool, durationMs });
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="Sentiment: ${sentiment}, Score: ${score}" duration=${durationMs}ms`
            );
            continue;
         }
         if (step.tool === 'reviewAnalysis') {
            const reviewText =
               typeof resolvedParameters.review_text === 'string'
                  ? resolvedParameters.review_text
                  : '';
            const start = Date.now();
            const response = await llmClient.generateText({
               model: 'gpt-4o-mini',
               instructions: reviewAnalysisPrompt,
               prompt: reviewText,
               temperature: 0.2,
               maxTokens: 80,
            });
            const durationMs = Date.now() - start;
            let score = 0;
            let summary = '';
            try {
               const parsed = JSON.parse(response.text);
               score = typeof parsed.score === 'number' ? parsed.score : 0;
               summary =
                  typeof parsed.summary === 'string' ? parsed.summary : '';
            } catch {}
            logLine(
               reqId,
               `[ReviewAnalysis] duration_ms=${durationMs} score=${score} summary="${summary}"`
            );
            results.push({
               tool: step.tool,
               text: `Summary: ${summary}, Score: ${score}`,
               data: score,
            });
            timings.steps.push({ tool: step.tool, durationMs });
            logLine(
               reqId,
               `Step ${stepNumber}/${totalSteps} result="Summary: ${summary}, Score: ${score}" duration=${durationMs}ms`
            );
            continue;
         }

         const fallback = 'הכלי שביקשת עדיין לא זמין.';
         results.push({
            tool: step.tool,
            text: fallback,
         });
         timings.steps.push({
            tool: step.tool,
            durationMs: Date.now() - stepStart,
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
         timings.steps.push({
            tool: step.tool,
            durationMs: Date.now() - stepStart,
         });
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
      const generalStart = Date.now();
      const response = await generalChat(history, userInput);
      timings.generalChatMs = Date.now() - generalStart;
      return finalize(response);
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
         return finalize(responseText);
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
      timings.synthesisMs = Date.now() - synthStart;
      logLine(reqId, `[SYNTH] duration=${timings.synthesisMs}ms`);

      return finalize(synthesis.text);
   }

   return finalize(results[results.length - 1]?.text ?? 'לא הצלחתי להשיב.');
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
