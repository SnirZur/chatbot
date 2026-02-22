export const topics = {
   userCommands: 'user-commands',
   conversationEvents: 'conversation-events',
   toolInvocationRequests: 'tool-invocation-requests',
   deadLetterQueue: 'dead-letter-queue',
   synthesisRequests: 'synthesis-requests',
   schemaRegistry: 'schema-registry',
} as const;

export type TopicName = (typeof topics)[keyof typeof topics];
