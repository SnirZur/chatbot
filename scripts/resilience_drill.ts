import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
   createKafka,
   createProducer,
   createConsumer,
   ensureTopics,
   waitForKafka,
} from '../src/node/lib/kafka';
import { topics } from '../src/node/lib/topics';

type ConversationEvent = {
   conversationId: string;
   userId: string;
   timestamp: string;
   eventType: string;
   payload: Record<string, unknown>;
};

type ToolCommand = {
   conversationId: string;
   userId: string;
   timestamp: string;
   commandType: 'ToolInvocationRequested';
   payload: {
      invocationId: string;
      tool: string;
      parameters: Record<string, unknown>;
      stepIndex: number;
   };
};

const rootDir = import.meta.dir.replace(/\/scripts$/, '');
const userId = 'resilience-drill-user';

const log = (message: string) => {
   const timestamp = new Date().toISOString();
   console.log(`[${timestamp}] ${message}`);
};

const dockerCompose = (...args: string[]) => {
   log(`docker compose ${args.join(' ')}`);
   execFileSync('docker', ['compose', ...args], {
      cwd: rootDir,
      stdio: 'inherit',
   });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

log('Starting minimal stack for resilience drills');
dockerCompose('up', '-d', 'zookeeper', 'kafka', 'orchestrator', 'math-worker');
await sleep(5000);

const kafka = createKafka('resilience-drill');
await waitForKafka(kafka);
await ensureTopics(kafka);

const producer = await createProducer(kafka);
const consumer = await createConsumer(
   kafka,
   `resilience-drill-${randomUUID()}`
);
await consumer.subscribe({
   topic: topics.conversationEvents,
   fromBeginning: false,
});

const seenEvents: ConversationEvent[] = [];
const waiters: Array<{
   predicate: (event: ConversationEvent) => boolean;
   resolve: (event: ConversationEvent) => void;
}> = [];

void consumer.run({
   eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString()) as ConversationEvent;
      seenEvents.push(event);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
         const waiter = waiters[index];
         if (waiter && waiter.predicate(event)) {
            waiters.splice(index, 1);
            waiter.resolve(event);
         }
      }
   },
});

const waitForEvent = (
   predicate: (event: ConversationEvent) => boolean,
   timeoutMs = 15000
) =>
   new Promise<ConversationEvent>((resolve, reject) => {
      const existing = seenEvents.find(predicate);
      if (existing) {
         resolve(existing);
         return;
      }
      const timer = setTimeout(() => {
         const index = waiters.findIndex(
            (waiter) => waiter.predicate === predicate
         );
         if (index >= 0) waiters.splice(index, 1);
         reject(new Error(`Timed out after ${timeoutMs}ms waiting for event`));
      }, timeoutMs);
      waiters.push({
         predicate,
         resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
         },
      });
   });

const assertNoEvent = async (
   predicate: (event: ConversationEvent) => boolean,
   timeoutMs = 3000
) => {
   try {
      const event = await waitForEvent(predicate, timeoutMs);
      throw new Error(
         `Unexpected event observed: ${event.eventType} for ${event.conversationId}`
      );
   } catch (error) {
      if ((error as Error).message.startsWith('Unexpected event observed')) {
         throw error;
      }
   }
};

const sendConversationEvent = async (event: ConversationEvent) => {
   await producer.send({
      topic: topics.conversationEvents,
      messages: [{ key: event.conversationId, value: JSON.stringify(event) }],
   });
};

const sendToolCommand = async (command: ToolCommand) => {
   await producer.send({
      topic: topics.toolInvocationRequests,
      messages: [
         { key: command.conversationId, value: JSON.stringify(command) },
      ],
   });
};

const makePlanGenerated = (
   conversationId: string,
   plan: Array<{ tool: string; parameters: Record<string, unknown> }>
): ConversationEvent => ({
   conversationId,
   userId,
   timestamp: new Date().toISOString(),
   eventType: 'PlanGenerated',
   payload: {
      plan: plan.map((step, index) => ({
         id: `step_${index + 1}`,
         purpose: `Run ${step.tool}`,
         dependsOn: index === 0 ? [] : [`step_${index}`],
         ...step,
      })),
      final_answer_synthesis_required: false,
   },
});

const makeToolResult = (
   conversationId: string,
   stepIndex: number,
   result: Record<string, unknown>
): ConversationEvent => ({
   conversationId,
   userId,
   timestamp: new Date().toISOString(),
   eventType: 'ToolInvocationResulted',
   payload: {
      invocationId: `${conversationId}-${stepIndex}`,
      tool: 'calculateMath',
      stepIndex,
      result,
   },
});

try {
   log('Drill 1: worker crash and recovery');
   dockerCompose('stop', 'math-worker');
   const workerConversationId = `worker-recovery-${randomUUID()}`;
   await sendConversationEvent(
      makePlanGenerated(workerConversationId, [
         { tool: 'calculateMath', parameters: { expression: '6 + 6' } },
      ])
   );
   await waitForEvent(
      (event) =>
         event.conversationId === workerConversationId &&
         event.eventType === 'ToolInvocationRequested',
      15000
   );
   await assertNoEvent(
      (event) =>
         event.conversationId === workerConversationId &&
         event.eventType === 'ToolInvocationResulted',
      3000
   );
   dockerCompose('start', 'math-worker');
   await sleep(2000);
   await waitForEvent(
      (event) =>
         event.conversationId === workerConversationId &&
         event.eventType === 'ToolInvocationResulted',
      15000
   );
   await waitForEvent(
      (event) =>
         event.conversationId === workerConversationId &&
         event.eventType === 'PlanCompleted',
      15000
   );
   log(`Worker recovery drill passed for ${workerConversationId}`);

   log('Drill 2: orchestrator crash and replay-backed recovery');
   dockerCompose('stop', 'math-worker');
   const orchestratorConversationId = `orchestrator-recovery-${randomUUID()}`;
   await sendConversationEvent(
      makePlanGenerated(orchestratorConversationId, [
         { tool: 'calculateMath', parameters: { expression: '2 + 2' } },
         {
            tool: 'calculateMath',
            parameters: { expression: '<result_from_tool_1> * 3' },
         },
      ])
   );
   await waitForEvent(
      (event) =>
         event.conversationId === orchestratorConversationId &&
         event.eventType === 'ToolInvocationRequested' &&
         Number(event.payload.stepIndex) === 0,
      15000
   );
   dockerCompose('stop', 'orchestrator');
   await sendConversationEvent(
      makeToolResult(orchestratorConversationId, 0, {
         text: 'התוצאה היא 4',
         data: 4,
      })
   );
   dockerCompose('start', 'orchestrator');
   await sleep(2000);
   await waitForEvent(
      (event) =>
         event.conversationId === orchestratorConversationId &&
         event.eventType === 'ToolInvocationRequested' &&
         Number(event.payload.stepIndex) === 1,
      15000
   );
   await sendConversationEvent(
      makeToolResult(orchestratorConversationId, 1, {
         text: 'התוצאה היא 12',
         data: 12,
      })
   );
   await waitForEvent(
      (event) =>
         event.conversationId === orchestratorConversationId &&
         event.eventType === 'PlanCompleted',
      15000
   );
   log(`Orchestrator recovery drill passed for ${orchestratorConversationId}`);

   log('Drill 3: duplicate invocation handling');
   dockerCompose('start', 'math-worker');
   await sleep(2000);
   const duplicateConversationId = `duplicate-${randomUUID()}`;
   const invocationId = `dup-${randomUUID()}`;
   const duplicateCommand: ToolCommand = {
      conversationId: duplicateConversationId,
      userId,
      timestamp: new Date().toISOString(),
      commandType: 'ToolInvocationRequested',
      payload: {
         invocationId,
         tool: 'calculateMath',
         parameters: { expression: '7 + 5' },
         stepIndex: 0,
      },
   };
   await sendToolCommand(duplicateCommand);
   await sendToolCommand(duplicateCommand);
   await waitForEvent(
      (event) =>
         event.conversationId === duplicateConversationId &&
         event.eventType === 'ToolInvocationResulted' &&
         String(event.payload.invocationId) === invocationId,
      15000
   );
   await assertNoEvent(
      (event) =>
         event.conversationId === duplicateConversationId &&
         event.eventType === 'ToolInvocationResulted' &&
         String(event.payload.invocationId) === invocationId &&
         seenEvents.filter(
            (candidate) =>
               candidate.conversationId === duplicateConversationId &&
               candidate.eventType === 'ToolInvocationResulted' &&
               String(candidate.payload.invocationId) === invocationId
         ).length > 1,
      3000
   );
   log(`Duplicate invocation drill passed for ${duplicateConversationId}`);
   log('All resilience drills passed');
} finally {
   await producer.disconnect().catch(() => undefined);
   await consumer.disconnect().catch(() => undefined);
}
