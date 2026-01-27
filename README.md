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
![Architecture Diagram](architecture.png)


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

## Challenges I Ran Into (Student Notes)

When I refactored the monolithic chatbot into Kafka microservices, a few things tripped me up:

- **Service startup order:** Some services tried to subscribe before Kafka was ready, so I had to add retry/wait logic.
- **Topic creation:** Auto-creation wasn’t always reliable, and missing topics caused consumer crashes until I enabled auto-create and added topic checks.
- **Debugging flows:** With multiple services, it was harder to trace a single request end‑to‑end compared to a single file.
- **History handling:** In the monolith, memory was just local state. With services, I had to pass history through Kafka and make sure the router actually had it.
- **Environment variables:** Each service runs on its own, so I had to make sure `.env` values were loaded for each process.

Overall, the refactor made the system more flexible, but it definitely added complexity to setup and debugging.

## Running Locally

1) Start Kafka + MySQL:

```
docker compose up -d
```

2) Install dependencies:

```
bun install
```

3) Create `packages/server/.env`:

```
OPENAI_API_KEY=sk-...
WEATHER_API_KEY=your_openweather_key
DATABASE_URL="mysql://jennifer:jennifer@localhost:3306/ai_course"
```

4) Run the microservices + web UI (two options):

Option A — one command (runs microservices + web server + client):

```
bun run full
```

Option B — run each process separately:

Microservices (separate terminals):

```
bun memoryService.ts
bun routerService.ts
bun responseAggregator.ts
bun mathApp.ts
bun weatherApp.ts
bun exchangeApp.ts
bun generalChatApp.ts
```

Web server:

```
cd ./packages/server
bun run dev
```

Web client:

```
cd ./packages/client
bun run dev
```
