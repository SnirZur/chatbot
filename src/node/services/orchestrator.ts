import {
   createKafka,
   createProducer,
   createConsumer,
   ensureTopics,
   runConsumerWithRestart,
   waitForKafka,
} from '../lib/kafka';
import { topics } from '../lib/topics';
import { schemaPaths, validateOrThrow } from '../lib/schema';
import { sendEvent } from '../lib/producer';
import { createStateStore, type OrchestratorState } from '../lib/stateStore';
import {
   publishSchemasOnce,
   startSchemaRegistryConsumer,
} from '../lib/schemaRegistry';
import {
   createIdempotencyStore,
   hasBeenProcessed,
   markProcessed,
} from '../lib/idempotencyStore';

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
const requestIdempotencyStore = createIdempotencyStore(
   '.state/idempotency/orchestrator-requests'
);

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
            if (output && typeof output === 'object' && 'rate' in output) {
               return String((output as { rate: unknown }).rate ?? '');
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
const producer = await producerPromise;
await publishSchemasOnce(producer);
await startSchemaRegistryConsumer(kafka, 'orchestrator-schema-registry');
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

await runConsumerWithRestart(
   requestsConsumer,
   async ({ message }) => {
      if (!message.value) return;
      let command: unknown;
      try {
         command = JSON.parse(message.value.toString());
      } catch (error) {
         const producer = await producerPromise;
         await producer.send({
            topic: topics.deadLetterQueue,
            messages: [
               {
                  value: JSON.stringify({
                     error: `Invalid JSON payload: ${(error as Error).message}`,
                     payload: message.value.toString(),
                  }),
               },
            ],
         });
         return;
      }
      try {
         validateOrThrow(schemaPaths.toolInvocationRequested, command);
      } catch (error) {
         const producer = await producerPromise;
         await producer.send({
            topic: topics.deadLetterQueue,
            messages: [
               {
                  value: JSON.stringify({
                     error: (error as Error).message,
                     payload: command,
                  }),
               },
            ],
         });
         return;
      }
      const invocationId = (command as { payload?: { invocationId?: unknown } })
         ?.payload?.invocationId;
      if (typeof invocationId === 'string') {
         if (await hasBeenProcessed(requestIdempotencyStore, invocationId)) {
            return;
         }
         await markProcessed(requestIdempotencyStore, invocationId);
      }
   },
   'orchestrator-requests'
);

await runConsumerWithRestart(
   eventsConsumer,
   async ({ message }) => {
      if (!message.value) return;
      let event: unknown;
      try {
         event = JSON.parse(message.value.toString());
      } catch (error) {
         const producer = await producerPromise;
         await producer.send({
            topic: topics.deadLetterQueue,
            messages: [
               {
                  value: JSON.stringify({
                     error: `Invalid JSON payload: ${(error as Error).message}`,
                     payload: message.value.toString(),
                  }),
               },
            ],
         });
         return;
      }
      if (!(event && typeof event === 'object' && 'eventType' in event)) return;
      const eventRecord = event as {
         eventType: string;
         conversationId: string;
         userId: string;
         payload: Record<string, unknown>;
      };

      const producer = await producerPromise;

      if (eventRecord.eventType === 'PlanGenerated') {
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
         const { conversationId, userId, payload } = eventRecord;
         const existing = await store.get(conversationId).catch(() => null);
         if (existing && existing.status !== 'FAILED') {
            return;
         }
         const state: OrchestratorState = {
            conversationId,
            userId,
            plan: (payload.plan ?? []) as Array<{
               tool: string;
               parameters: Record<string, unknown>;
            }>,
            final_answer_synthesis_required: Boolean(
               payload.final_answer_synthesis_required
            ),
            stepIndex: 0,
            results: [],
            status: 'RUNNING',
         };
         await store.put(conversationId, state);
         await sendToolInvocation(state, 0);
         return;
      }

      if (eventRecord.eventType === 'ToolInvocationResulted') {
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
         const conversationId = eventRecord.conversationId;
         const payload = eventRecord.payload as {
            stepIndex: number;
            tool: string;
            result: unknown;
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

      if (eventRecord.eventType === 'PlanFailed') {
         const { conversationId } = eventRecord;
         const state = await store.get(conversationId).catch(() => null);
         if (!state) return;
         state.status = 'FAILED';
         await store.put(conversationId, state);
      }
   },
   'orchestrator-events'
);
