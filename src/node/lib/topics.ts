export const topics = {
   userCommands: 'user-commands',
   conversationEvents: 'conversation-events',
   toolInvocationRequests: 'tool-invocation-requests',
   finalSynthesisRequests: 'final-synthesis-requests',
   deadLetterQueue: 'dead-letter-queue',
   schemaRegistry: 'schema-registry',
} as const;

export type TopicName = (typeof topics)[keyof typeof topics];
