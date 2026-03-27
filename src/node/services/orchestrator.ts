import { randomUUID } from 'node:crypto';
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

type ConversationEventRecord = {
   eventType: string;
   conversationId: string;
   userId: string;
   payload: Record<string, unknown>;
};

const getCompletedStepIds = (state: OrchestratorState) => {
   const completed = new Set<string>();
   for (const [index, step] of state.plan.entries()) {
      if (state.results[index]) completed.add(step.id);
   }
   return completed;
};

const findNextRunnableStepIndex = (state: OrchestratorState) => {
   const completedStepIds = getCompletedStepIds(state);
   for (const [index, step] of state.plan.entries()) {
      if (state.results[index]) continue;
      if (
         step.dependsOn.every((dependency) => completedStepIds.has(dependency))
      ) {
         return index;
      }
   }
   return null;
};

const recalculateProgress = (state: OrchestratorState) => {
   const completedCount = state.results.filter(Boolean).length;
   const nextRunnableStepIndex = findNextRunnableStepIndex(state);
   if (completedCount >= state.plan.length) {
      state.stepIndex = state.plan.length;
      state.status = 'COMPLETED';
      return;
   }
   if (nextRunnableStepIndex === null) {
      state.stepIndex = state.plan.length;
      state.status = 'FAILED';
      return;
   }
   state.stepIndex = nextRunnableStepIndex;
   state.status = 'RUNNING';
};

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

const emitPlanCompleted = async (state: OrchestratorState) => {
   if (state.planCompletedEmitted) return;
   const producer = await producerPromise;
   await sendEvent(producer, schemaPaths.planCompleted, state.conversationId, {
      conversationId: state.conversationId,
      userId: state.userId,
      timestamp: new Date().toISOString(),
      eventType: 'PlanCompleted',
      payload: {
         final_answer_synthesis_required: state.final_answer_synthesis_required,
      },
   });
   state.planCompletedEmitted = true;
   state.status = 'COMPLETED';
   await store.put(state.conversationId, state);
};

const failPlan = async (
   conversationId: string,
   userId: string,
   reason: string,
   payload?: unknown
) => {
   const producer = await producerPromise;
   await producer.send({
      topic: topics.deadLetterQueue,
      messages: [
         {
            value: JSON.stringify({
               error: reason,
               payload,
            }),
         },
      ],
   });
   await sendEvent(producer, schemaPaths.planFailed, conversationId, {
      conversationId,
      userId,
      timestamp: new Date().toISOString(),
      eventType: 'PlanFailed',
      payload: { reason },
   });
};

const buildStateFromPlan = (
   eventRecord: ConversationEventRecord
): OrchestratorState => {
   const state: OrchestratorState = {
      conversationId: eventRecord.conversationId,
      userId: eventRecord.userId,
      plan: (eventRecord.payload.plan ?? []) as Array<{
         id: string;
         purpose: string;
         dependsOn: string[];
         tool: string;
         parameters: Record<string, unknown>;
      }>,
      final_answer_synthesis_required: Boolean(
         eventRecord.payload.final_answer_synthesis_required
      ),
      stepIndex: 0,
      results: [],
      planCompletedEmitted: false,
      status: 'RUNNING',
   };
   recalculateProgress(state);
   return state;
};

const applyEventToState = async (eventRecord: ConversationEventRecord) => {
   if (eventRecord.eventType === 'PlanGenerated') {
      const state = buildStateFromPlan(eventRecord);
      await store.put(eventRecord.conversationId, state);
      return state;
   }

   if (eventRecord.eventType === 'ToolInvocationResulted') {
      const payload = eventRecord.payload as {
         stepIndex: number;
         tool: string;
         result: unknown;
      };
      const state = await store
         .get(eventRecord.conversationId)
         .catch(() => null);
      if (!state) return null;
      if (!state.results[payload.stepIndex]) {
         state.results[payload.stepIndex] = {
            tool: payload.tool,
            result: payload.result,
         };
      }
      recalculateProgress(state);
      await store.put(eventRecord.conversationId, state);
      return state;
   }

   if (eventRecord.eventType === 'PlanFailed') {
      const state = await store
         .get(eventRecord.conversationId)
         .catch(() => null);
      if (!state) return null;
      state.status = 'FAILED';
      await store.put(eventRecord.conversationId, state);
      return state;
   }

   if (eventRecord.eventType === 'PlanCompleted') {
      const state = await store
         .get(eventRecord.conversationId)
         .catch(() => null);
      if (!state) return null;
      state.status = 'COMPLETED';
      state.planCompletedEmitted = true;
      await store.put(eventRecord.conversationId, state);
      return state;
   }

   return null;
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
   fromBeginning: false,
});
await requestsConsumer.subscribe({
   topic: topics.toolInvocationRequests,
   fromBeginning: false,
});

const replayConversationEvents = async () => {
   const admin = kafka.admin();
   await admin.connect();
   let lastOffset = '0';
   try {
      const offsets = await admin.fetchTopicOffsets(topics.conversationEvents);
      lastOffset = offsets[0]?.offset ?? '0';
   } finally {
      await admin.disconnect();
   }

   await store.clear();

   if (Number(lastOffset) === 0) {
      return;
   }

   const replayConsumer = await createConsumer(
      kafka,
      `orchestrator-replay-${randomUUID()}`
   );
   await replayConsumer.subscribe({
      topic: topics.conversationEvents,
      fromBeginning: false,
   });

   await new Promise<void>((resolve, reject) => {
      let resolved = false;
      void replayConsumer
         .run({
            autoCommit: false,
            eachMessage: async ({ message, heartbeat }) => {
               if (!message.value) return;
               const offset = Number(message.offset);
               let event: unknown;
               try {
                  event = JSON.parse(message.value.toString());
               } catch {
                  return;
               }
               if (
                  event &&
                  typeof event === 'object' &&
                  'eventType' in event &&
                  'conversationId' in event &&
                  'userId' in event &&
                  'payload' in event
               ) {
                  await applyEventToState(event as ConversationEventRecord);
               }
               await heartbeat();
               if (offset >= Number(lastOffset) - 1 && !resolved) {
                  resolved = true;
                  resolve();
               }
            },
         })
         .catch((error) => {
            if (!resolved) reject(error);
         });
   });

   await replayConsumer.stop();
   await replayConsumer.disconnect();
};

const recoverRunningPlans = async () => {
   for await (const [, state] of store.iterator()) {
      recalculateProgress(state);
      await store.put(state.conversationId, state);
      if (state.status === 'FAILED') {
         await failPlan(
            state.conversationId,
            state.userId,
            'Recovered plan contains unsatisfied or cyclic dependencies',
            state
         );
         continue;
      }
      if (!state.planCompletedEmitted && state.stepIndex >= state.plan.length) {
         await emitPlanCompleted(state);
         continue;
      }
      if (state.status === 'RUNNING' && state.stepIndex < state.plan.length) {
         await sendToolInvocation(state, state.stepIndex);
      }
   }
};

await replayConversationEvents();
await recoverRunningPlans();

const requestsLoop = runConsumerWithRestart(
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
      // Intentionally no state mutation here: orchestration state transitions
      // are driven by immutable conversation events.
   },
   'orchestrator-requests'
);

const eventsLoop = runConsumerWithRestart(
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
      const eventRecord = event as ConversationEventRecord;

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
         const existing = await store
            .get(eventRecord.conversationId)
            .catch(() => null);
         if (existing && existing.status !== 'FAILED') {
            return;
         }
         const state = buildStateFromPlan(eventRecord);
         await store.put(eventRecord.conversationId, state);
         try {
            if (state.status === 'FAILED') {
               await failPlan(
                  eventRecord.conversationId,
                  eventRecord.userId,
                  'Plan contains unsatisfied or cyclic dependencies',
                  state
               );
            } else if (state.plan.length === 0) {
               state.status = 'COMPLETED';
               await store.put(eventRecord.conversationId, state);
               await emitPlanCompleted(state);
            } else {
               await sendToolInvocation(state, state.stepIndex);
            }
         } catch (error) {
            await failPlan(
               eventRecord.conversationId,
               eventRecord.userId,
               (error as Error).message,
               state
            );
         }
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

         await applyEventToState(eventRecord);
         const updatedState = await store.get(conversationId);

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

         if (updatedState.stepIndex >= updatedState.plan.length) {
            await emitPlanCompleted(updatedState);
            return;
         }

         try {
            await sendToolInvocation(updatedState, updatedState.stepIndex);
         } catch (error) {
            await failPlan(
               conversationId,
               updatedState.userId,
               (error as Error).message,
               updatedState
            );
         }
      }

      if (eventRecord.eventType === 'PlanFailed') {
         await applyEventToState(eventRecord);
      }

      if (eventRecord.eventType === 'PlanCompleted') {
         await applyEventToState(eventRecord);
      }
   },
   'orchestrator-events'
);

await Promise.all([requestsLoop, eventsLoop]);
