# Kafka Microservices Chatbot

This project refactors the class chatbot into a Kafka-based microservices architecture using Bun.

## Services and Topics

| Service | Consumes | Produces |
| --- | --- | --- |
| `userInterface.ts` | `bot-responses` | `user-input-events`, `user-control-events` |
| `memoryService.ts` | `user-input-events`, `app-results`, `user-control-events` | `conversation-history-update` |
| `routerService.ts` | `user-input-events`, `conversation-history-update` | `intent-math`, `intent-weather`, `intent-exchange`, `intent-general-chat` |
| `mathApp.ts` | `intent-math` | `app-results` |
| `weatherApp.ts` | `intent-weather` | `app-results` |
| `exchangeApp.ts` | `intent-exchange` | `app-results` |
| `generalChatApp.ts` | `intent-general-chat` | `app-results` |
| `responseAggregator.ts` | `app-results` | `bot-responses` |

Kafka topics (exact names):
- `user-input-events`
- `app-results`
- `bot-responses`
- `user-control-events`
- `intent-math`
- `intent-weather`
- `intent-exchange`
- `intent-general-chat`
- `conversation-history-update`
- `conversation-history-request`

## Architecture (PlantUML)

```plantuml
@startuml
actor User

User -> "userInterface.ts"
"userInterface.ts" --> "user-input-events"
"userInterface.ts" --> "user-control-events"

"user-input-events" --> "routerService.ts"
"conversation-history-update" --> "routerService.ts"

"routerService.ts" --> "intent-math"
"routerService.ts" --> "intent-weather"
"routerService.ts" --> "intent-exchange"
"routerService.ts" --> "intent-general-chat"

"intent-math" --> "mathApp.ts"
"intent-weather" --> "weatherApp.ts"
"intent-exchange" --> "exchangeApp.ts"
"intent-general-chat" --> "generalChatApp.ts"

"mathApp.ts" --> "app-results"
"weatherApp.ts" --> "app-results"
"exchangeApp.ts" --> "app-results"
"generalChatApp.ts" --> "app-results"

"app-results" --> "memoryService.ts"
"user-input-events" --> "memoryService.ts"
"user-control-events" --> "memoryService.ts"
"memoryService.ts" --> "conversation-history-update"

"app-results" --> "responseAggregator.ts"
"responseAggregator.ts" --> "bot-responses"
"bot-responses" --> "userInterface.ts"
@enduml
```

## Running Locally

1) Start Kafka + MySQL:

```
docker compose up -d
```

2) Install dependencies:

```
bun install
```

3) Run each service in its own terminal:

```
bun userInterface.ts
bun memoryService.ts
bun routerService.ts
bun mathApp.ts
bun weatherApp.ts
bun exchangeApp.ts
bun generalChatApp.ts
bun responseAggregator.ts
```

## Environment Variables

- `OPENAI_API_KEY` for `generalChatApp.ts`
- `OPENWEATHER_API_KEY` for `weatherApp.ts`
