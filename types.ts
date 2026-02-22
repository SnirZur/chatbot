export type ConversationTurn = {
   role: 'user' | 'assistant';
   content: string;
   timestamp?: string;
};

export type ConversationHistory = ConversationTurn[];

export type UserInputEvent = {
   userInput: string;
   conversationId?: string;
   conversationStartedAt?: string;
};

export type UserControlEvent = {
   command: 'reset';
};

export type AppResultEvent = {
   type: 'math' | 'weather' | 'exchange' | 'chat';
   result: string;
};

export type HistoryUpdateEvent = {
   history: ConversationHistory;
};

export type IntentMathEvent = {
   expression: string;
};

export type IntentWeatherEvent = {
   city: string;
};

export type IntentExchangeEvent = {
   currencyCode: string;
};

export type IntentGeneralChatEvent = {
   context: ConversationHistory;
   userInput: string;
};

export const topics = {
   userInput: 'user-input-events',
   appResults: 'app-results',
   botResponses: 'bot-responses',
   userControl: 'user-control-events',
   intentMath: 'intent-math',
   intentWeather: 'intent-weather',
   intentExchange: 'intent-exchange',
   intentGeneralChat: 'intent-general-chat',
   historyUpdate: 'conversation-history-update',
   historyRequest: 'conversation-history-request',
} as const;
