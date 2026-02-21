import {
   createKafka,
   createProducer,
   createConsumer,
   ensureTopics,
   waitForKafka,
} from '../lib/kafka';
import { topics } from '../lib/topics';
import { schemaPaths, validateOrThrow } from '../lib/schema';
import { sendEvent } from '../lib/producer';
import { createStateStore, type OrchestratorState } from '../lib/stateStore';

const kafka = createKafka('orchestrator-service');
const producerPromise = createProducer(kafka);
const consumerEventsPromise = createConsumer(
   kafka,
   'orchestrator-events-group'
);
const consumerRequestsPromise = createConsumer(
   kafka,
   'orchestrator-requests-group'
);

const store = createStateStore('.state/orchestrator');

const resolvePlaceholders = (
   params: Record<string, unknown>,
   results: OrchestratorState['results']
) => {
   const replace = (value: unknown): unknown => {
      if (typeof value === 'string') {
         return value.replace(/<result_from_tool_(\d+)>/g, (_match, index) => {
            const result = results[Number(index) - 1];
            if (!result) return '';
            const output = result.result as
               | { data?: unknown; text?: string }
               | string
               | Record<string, unknown>;
            if (typeof output === 'string') return output;
            if (output && typeof output === 'object' && 'data' in output) {
               return String((output as { data: unknown }).data ?? '');
            }
            if (output && typeof output === 'object' && 'text' in output) {
               return String((output as { text: unknown }).text ?? '');
            }
            if (output && typeof output === 'object') {
               return JSON.stringify(output);
            }
            return '';
         });
      }
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === 'object') {
         return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, replace(v)])
         );
      }
      return value;
   };
   return replace(params) as Record<string, unknown>;
};

const sendToolInvocation = async (
   state: OrchestratorState,
   stepIndex: number
) => {
   const step = state.plan[stepIndex];
   if (!step) return;
   const producer = await producerPromise;
   const invocationId = `${state.conversationId}-${stepIndex}`;
   const resolvedParams = resolvePlaceholders(step.parameters, state.results);
   const command = {
      conversationId: state.conversationId,
      userId: state.userId,
      timestamp: new Date().toISOString(),
      commandType: 'ToolInvocationRequested',
      payload: {
         invocationId,
         tool: step.tool,
         parameters: resolvedParams,
         stepIndex,
      },
   };
   validateOrThrow(schemaPaths.toolInvocationRequested, command);
   await producer.send({
      topic: topics.toolInvocationRequests,
      messages: [{ key: state.conversationId, value: JSON.stringify(command) }],
   });

   await sendEvent(
      producer,
      schemaPaths.toolInvocationRequestedEvent,
      state.conversationId,
      {
         conversationId: state.conversationId,
         userId: state.userId,
         timestamp: new Date().toISOString(),
         eventType: 'ToolInvocationRequested',
         payload: {
            invocationId,
            tool: step.tool,
            stepIndex,
         },
      }
   );
};

await waitForKafka(kafka);
await ensureTopics(kafka);

const eventsConsumer = await consumerEventsPromise;
const requestsConsumer = await consumerRequestsPromise;
await eventsConsumer.subscribe({
   topic: topics.conversationEvents,
   fromBeginning: true,
});
await requestsConsumer.subscribe({
   topic: topics.toolInvocationRequests,
   fromBeginning: true,
});

const recoverRunningPlans = async () => {
   for await (const [conversationId, state] of store.iterator()) {
      if (state.status === 'RUNNING' && state.stepIndex < state.plan.length) {
         await sendToolInvocation(state, state.stepIndex);
      }
   }
};

await recoverRunningPlans();

await eventsConsumer.run({
   eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString());
      if (!event || !event.eventType) return;

      const producer = await producerPromise;

      if (event.eventType === 'PlanGenerated') {
         try {
            validateOrThrow(schemaPaths.planGenerated, event);
         } catch (error) {
            await producer.send({
               topic: topics.deadLetterQueue,
               messages: [
                  {
                     value: JSON.stringify({
                        error: (error as Error).message,
                        payload: event,
                     }),
                  },
               ],
            });
            return;
         }
         const { conversationId, userId, payload } = event;
         const existing = await store.get(conversationId).catch(() => null);
         if (existing && existing.status !== 'FAILED') {
            return;
         }
         const state: OrchestratorState = {
            conversationId,
            userId,
            plan: payload.plan ?? [],
            final_answer_synthesis_required:
               payload.final_answer_synthesis_required ?? false,
            stepIndex: 0,
            results: [],
            status: 'RUNNING',
         };
         await store.put(conversationId, state);
         await sendToolInvocation(state, 0);
         return;
      }

      if (event.eventType === 'ToolInvocationResulted') {
         try {
            validateOrThrow(schemaPaths.toolInvocationResulted, event);
         } catch (error) {
            await producer.send({
               topic: topics.deadLetterQueue,
               messages: [
                  {
                     value: JSON.stringify({
                        error: (error as Error).message,
                        payload: event,
                     }),
                  },
               ],
            });
            return;
         }
         const { conversationId, payload } = event as {
            conversationId: string;
            payload: { stepIndex: number; tool: string; result: unknown };
         };
         const state = await store.get(conversationId).catch(() => null);
         if (!state) return;
         if (state.results[payload.stepIndex]) return; // idempotent

         state.results[payload.stepIndex] = {
            tool: payload.tool,
            result: payload.result,
         };
         state.stepIndex = payload.stepIndex + 1;
         await store.put(conversationId, state);

         await sendEvent(
            producer,
            schemaPaths.planStepCompleted,
            conversationId,
            {
               conversationId,
               userId: state.userId,
               timestamp: new Date().toISOString(),
               eventType: 'PlanStepCompleted',
               payload: { stepIndex: payload.stepIndex, tool: payload.tool },
            }
         );

         if (state.stepIndex >= state.plan.length) {
            state.status = 'COMPLETED';
            await store.put(conversationId, state);
            await sendEvent(
               producer,
               schemaPaths.planCompleted,
               conversationId,
               {
                  conversationId,
                  userId: state.userId,
                  timestamp: new Date().toISOString(),
                  eventType: 'PlanCompleted',
                  payload: {
                     final_answer_synthesis_required:
                        state.final_answer_synthesis_required,
                  },
               }
            );
            return;
         }

         await sendToolInvocation(state, state.stepIndex);
      }

      if (event.eventType === 'PlanFailed') {
         const { conversationId } = event as { conversationId: string };
         const state = await store.get(conversationId).catch(() => null);
         if (!state) return;
         state.status = 'FAILED';
         await store.put(conversationId, state);
      }
   },
});

await requestsConsumer.run({
   eachMessage: async () => {
      // intentionally empty: this consumer keeps the group active to avoid duplicate invocations
   },
});
