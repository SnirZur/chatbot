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
            'tool-worker-service'
         );
      case 'PlanCompleted':
         return 'synthesis-worker';
      default:
         return 'orchestrator-service';
   }
};

const waitForResponse = (conversationId: string, timeoutMs = 30000) =>
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
         conversationState.set(conversationId, current);
      }
      if (event?.eventType !== 'FinalAnswerSynthesized') return;
      if (!conversationId) return;
      const resolver = pending.get(conversationId);
      if (resolver && event.payload?.message) {
         pending.delete(conversationId);
         conversationState.delete(conversationId);
         resolver({ message: event.payload.message });
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
      console.log(`Bot: ${response.message}`);
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
