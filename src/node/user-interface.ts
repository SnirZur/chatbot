import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import {
   createKafka,
   createProducer,
   createConsumer,
   ensureTopics,
   runConsumerWithRestart,
   waitForKafka,
} from './lib/kafka';
import { topics } from './lib/topics';
import { schemaPaths, validateOrThrow } from './lib/schema';

type BotResponse = { message: string };
type ConversationState = {
   lastEventType?: string;
   lastRequestedTool?: string;
   toolResults?: unknown[];
};

const kafka = createKafka('user-interface');
const producerPromise = createProducer(kafka);
const consumerPromise = createConsumer(
   kafka,
   `user-interface-group-${randomUUID()}`
);

const userId = randomUUID();
const pending = new Map<string, (response: BotResponse) => void>();
const conversationState = new Map<string, ConversationState>();
const LRI = '\u2066';
const RLI = '\u2067';
const PDI = '\u2069';

const stabilizeBidi = (text: string) => {
   if (!/[\u0590-\u05FF]/.test(text)) return text;
   const wrappedLtrTokens = text.replace(
      /([A-Za-z][A-Za-z0-9._:+-]*|\d+(?:[.,]\d+)?)/g,
      `${LRI}$1${PDI}`
   );
   return `${RLI}${wrappedLtrTokens}${PDI}`;
};

const toolToService: Record<string, string> = {
   calculateMath: 'math-worker',
   getExchangeRate: 'exchange-rate-worker',
   getWeather: 'weather-worker',
   getProductInformation: 'rag-retriever-worker',
   ragGeneration: 'llm-inference-worker',
   generalChat: 'llm-inference-worker',
};

const guessUnavailableService = (conversationId: string): string => {
   const state = conversationState.get(conversationId);
   if (!state?.lastEventType) return 'router-service';

   switch (state.lastEventType) {
      case 'UserQueryReceived':
         return 'router-service';
      case 'PlanGenerated':
      case 'ToolInvocationResulted':
      case 'PlanStepCompleted':
         return 'orchestrator-service';
      case 'ToolInvocationRequested':
         return (
            toolToService[state.lastRequestedTool ?? ''] ??
            'tool-execution-service'
         );
      case 'PlanCompleted':
         return 'synthesis-worker';
      default:
         return 'orchestrator-service';
   }
};

const summarizeToolResults = (results: unknown[] = []) => {
   for (let i = results.length - 1; i >= 0; i -= 1) {
      const result = results[i];
      if (typeof result === 'string' && result.trim()) return result;
      if (result && typeof result === 'object') {
         const asObject = result as {
            text?: unknown;
            chunks?: unknown;
            data?: unknown;
         };
         if (typeof asObject.text === 'string' && asObject.text.trim()) {
            return asObject.text;
         }
         if (typeof asObject.data === 'string' && asObject.data.trim()) {
            return asObject.data;
         }
         if (Array.isArray(asObject.chunks) && asObject.chunks.length > 0) {
            const lines = asObject.chunks
               .map((chunk) => (typeof chunk === 'string' ? chunk.trim() : ''))
               .filter((chunk) => chunk.length > 0)
               .slice(0, 20);
            if (lines.length > 0) return lines.join('\n\n');
         }
      }
   }
   return 'The request was completed, but no textual answer payload was produced.';
};

const waitForResponse = (conversationId: string, timeoutMs = 90000) =>
   new Promise<BotResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
         pending.delete(conversationId);
         reject(new Error('Timed out waiting for bot response'));
      }, timeoutMs);
      pending.set(conversationId, (response) => {
         clearTimeout(timer);
         resolve(response);
      });
   });

await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await producerPromise;
const consumer = await consumerPromise;

await consumer.subscribe({
   topic: topics.conversationEvents,
   fromBeginning: false,
});

const consumerLoop = runConsumerWithRestart(
   consumer,
   async ({ message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString());
      const conversationId = String(event.conversationId ?? '');
      if (conversationId) {
         const current = conversationState.get(conversationId) ?? {};
         current.lastEventType = String(event.eventType ?? '');
         if (event.eventType === 'ToolInvocationRequested') {
            current.lastRequestedTool = String(event.payload?.tool ?? '');
         }
         if (event.eventType === 'ToolInvocationResulted') {
            const stepIndex = Number(event.payload?.stepIndex);
            if (Number.isInteger(stepIndex) && stepIndex >= 0) {
               current.toolResults ??= [];
               current.toolResults[stepIndex] = event.payload?.result;
            }
         }
         conversationState.set(conversationId, current);
      }
      if (event?.eventType === 'FinalAnswerSynthesized') {
         if (!conversationId) return;
         const resolver = pending.get(conversationId);
         if (resolver && event.payload?.message) {
            pending.delete(conversationId);
            conversationState.delete(conversationId);
            resolver({ message: event.payload.message });
         }
         return;
      }

      if (event?.eventType === 'PlanCompleted') {
         if (!conversationId) return;
         const resolver = pending.get(conversationId);
         const needsSynthesis = Boolean(
            event.payload?.final_answer_synthesis_required
         );
         if (resolver && !needsSynthesis) {
            const state = conversationState.get(conversationId);
            pending.delete(conversationId);
            conversationState.delete(conversationId);
            resolver({ message: summarizeToolResults(state?.toolResults) });
         }
      }

      if (event?.eventType === 'PlanFailed') {
         if (!conversationId) return;
         const resolver = pending.get(conversationId);
         if (resolver) {
            pending.delete(conversationId);
            conversationState.delete(conversationId);
            resolver({
               message:
                  String(event.payload?.reason ?? '').trim() ||
                  'The orchestration plan failed to complete.',
            });
         }
      }
   },
   'user-interface'
);

const rl = readline.createInterface({
   input: process.stdin,
   output: process.stdout,
});

const promptLine = () =>
   new Promise<string>((resolve) => rl.question('You: ', resolve));

console.log(`UserId: ${userId}`);

while (true) {
   const input = (await promptLine()).trim();
   if (!input) continue;
   if (input === '/exit') break;
   if (input === '/reset') {
      const resetCommand = {
         conversationId: randomUUID(),
         userId,
         timestamp: new Date().toISOString(),
         commandType: 'UserControl',
         payload: { command: 'reset' },
      };
      validateOrThrow(schemaPaths.userControl, resetCommand);
      await producer.send({
         topic: topics.userCommands,
         messages: [{ key: userId, value: JSON.stringify(resetCommand) }],
      });
      console.log('Bot: היסטוריית השיחה אופסה.');
      continue;
   }

   const conversationId = randomUUID();
   const command = {
      conversationId,
      userId,
      timestamp: new Date().toISOString(),
      commandType: 'UserQueryReceived',
      payload: { userInput: input },
   };

   validateOrThrow(schemaPaths.userQueryReceived, command);
   await producer.send({
      topic: topics.userCommands,
      messages: [{ key: conversationId, value: JSON.stringify(command) }],
   });

   try {
      const response = await waitForResponse(conversationId);
      console.log(`Bot: ${stabilizeBidi(response.message)}`);
   } catch {
      const serviceName = guessUnavailableService(conversationId);
      pending.delete(conversationId);
      console.log(
         `Bot: microservice named ${serviceName} is currently unavailable and therefore the question can't be processed at the moment.`
      );
   }
}

rl.close();
await consumer.disconnect();
await producer.disconnect();
void consumerLoop;
