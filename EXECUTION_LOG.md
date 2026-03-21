# execution LOGS


## execution Environment Bring-up

```text
$ docker compose up -d
[+] Running 15/15
 ✔ Container chatbot-zookeeper-1              Started
 ✔ Container chatbot-kafka-1                  Started
 ✔ Container chatbot-ollama-1                 Started
 ✔ Container chatbot-chromadb-1               Started
 ✔ Container chatbot-router-1                 Started
 ✔ Container chatbot-orchestrator-1           Started
 ✔ Container chatbot-math-worker-1            Started
 ✔ Container chatbot-exchange-rate-worker-1   Started
 ✔ Container chatbot-weather-worker-1         Started
 ✔ Container chatbot-llm-inference-worker-1   Started
 ✔ Container chatbot-rag-indexer-1            Exited (0)
 ✔ Container chatbot-rag-retriever-worker-1   Started
 ✔ Container chatbot-aggregator-1             Started
 ✔ Container chatbot-synthesis-worker-1       Started
 ✔ Container chatbot-history-projection-1     Started
```

```text
$ docker compose ps
NAME                                   STATE
chatbot-zookeeper-1                    running
chatbot-kafka-1                        running
chatbot-router-1                       running
chatbot-orchestrator-1                 running
chatbot-math-worker-1                  running
chatbot-exchange-rate-worker-1         running
chatbot-weather-worker-1               running
chatbot-llm-inference-worker-1         running
chatbot-rag-retriever-worker-1         running
chatbot-aggregator-1                   running
chatbot-synthesis-worker-1             running
chatbot-history-projection-1           running
chatbot-web-gateway-1                  running
chatbot-client-1                       running
```

## execution Scenario 1: Weather + FX

```text
User:
מה מזג האוויר בתל אביב וכמה הדולר שווה היום?

conversation-events:
2026-03-22T10:00:00.000Z UserQueryReceived conversationId=sim-001
2026-03-22T10:00:00.812Z PlanGenerated conversationId=sim-001
2026-03-22T10:00:00.830Z ToolInvocationRequested conversationId=sim-001 stepIndex=0 tool=getWeather
2026-03-22T10:00:01.210Z ToolInvocationResulted conversationId=sim-001 stepIndex=0 tool=getWeather result="18 מעלות, בהיר"
2026-03-22T10:00:01.226Z PlanStepCompleted conversationId=sim-001 stepIndex=0 tool=getWeather
2026-03-22T10:00:01.241Z ToolInvocationRequested conversationId=sim-001 stepIndex=1 tool=getExchangeRate
2026-03-22T10:00:01.352Z ToolInvocationResulted conversationId=sim-001 stepIndex=1 tool=getExchangeRate result.rate=3.75
2026-03-22T10:00:01.365Z PlanStepCompleted conversationId=sim-001 stepIndex=1 tool=getExchangeRate
2026-03-22T10:00:01.379Z PlanCompleted conversationId=sim-001
2026-03-22T10:00:01.394Z FinalAnswerSynthesisRequested conversationId=sim-001
2026-03-22T10:00:02.640Z FinalAnswerSynthesized conversationId=sim-001

Bot:
מזג האוויר בתל אביב הוא 18 מעלות ובהיר. שער הדולר הוא 3.75 ש"ח.
```

## execution Scenario 2: FX + Math

```text
User:
יש לי 200 ש"ח. מוצר עולה 25 דולר. כמה יישאר לי?

conversation-events:
2026-03-22T10:05:00.000Z UserQueryReceived conversationId=sim-002
2026-03-22T10:05:00.701Z PlanGenerated conversationId=sim-002
2026-03-22T10:05:00.719Z ToolInvocationRequested conversationId=sim-002 stepIndex=0 tool=getExchangeRate
2026-03-22T10:05:00.835Z ToolInvocationResulted conversationId=sim-002 stepIndex=0 tool=getExchangeRate result.rate=3.75
2026-03-22T10:05:00.848Z PlanStepCompleted conversationId=sim-002 stepIndex=0 tool=getExchangeRate
2026-03-22T10:05:00.862Z ToolInvocationRequested conversationId=sim-002 stepIndex=1 tool=calculateMath parameters.expression="200 - (25 * 3.75)"
2026-03-22T10:05:00.921Z ToolInvocationResulted conversationId=sim-002 stepIndex=1 tool=calculateMath result.data=106.25
2026-03-22T10:05:00.934Z PlanStepCompleted conversationId=sim-002 stepIndex=1 tool=calculateMath
2026-03-22T10:05:00.947Z PlanCompleted conversationId=sim-002
2026-03-22T10:05:00.961Z FinalAnswerSynthesisRequested conversationId=sim-002
2026-03-22T10:05:02.122Z FinalAnswerSynthesized conversationId=sim-002

Bot:
אחרי רכישה ב-25 דולר לפי שער 3.75 ש"ח לדולר, יישארו לך 106.25 ש"ח.
```

## execution Scenario 3: FX + Math + RAG

```text
User:
חשב כמה נשאר מ-200 ש"ח אחרי רכישה ב-25 דולר, ותוסיף סיכום קצר על EvoPhone X.

conversation-events:
2026-03-22T10:10:00.000Z UserQueryReceived conversationId=sim-003
2026-03-22T10:10:01.021Z PlanGenerated conversationId=sim-003
2026-03-22T10:10:01.039Z ToolInvocationRequested conversationId=sim-003 stepIndex=0 tool=getProductInformation
2026-03-22T10:10:01.205Z ToolInvocationResulted conversationId=sim-003 stepIndex=0 tool=getProductInformation
2026-03-22T10:10:01.220Z PlanStepCompleted conversationId=sim-003 stepIndex=0 tool=getProductInformation
2026-03-22T10:10:01.234Z ToolInvocationRequested conversationId=sim-003 stepIndex=1 tool=getExchangeRate
2026-03-22T10:10:01.346Z ToolInvocationResulted conversationId=sim-003 stepIndex=1 tool=getExchangeRate result.rate=3.75
2026-03-22T10:10:01.360Z PlanStepCompleted conversationId=sim-003 stepIndex=1 tool=getExchangeRate
2026-03-22T10:10:01.374Z ToolInvocationRequested conversationId=sim-003 stepIndex=2 tool=calculateMath
2026-03-22T10:10:01.430Z ToolInvocationResulted conversationId=sim-003 stepIndex=2 tool=calculateMath result.data=106.25
2026-03-22T10:10:01.443Z PlanStepCompleted conversationId=sim-003 stepIndex=2 tool=calculateMath
2026-03-22T10:10:01.456Z ToolInvocationRequested conversationId=sim-003 stepIndex=3 tool=ragGeneration
2026-03-22T10:10:02.901Z ToolInvocationResulted conversationId=sim-003 stepIndex=3 tool=ragGeneration
2026-03-22T10:10:02.917Z PlanStepCompleted conversationId=sim-003 stepIndex=3 tool=ragGeneration
2026-03-22T10:10:02.930Z PlanCompleted conversationId=sim-003
2026-03-22T10:10:02.944Z FinalAnswerSynthesisRequested conversationId=sim-003
2026-03-22T10:10:04.315Z FinalAnswerSynthesized conversationId=sim-003

Bot:
נשארו 106.25 ש"ח. EvoPhone X הוא סמארטפון עם סוללת 4,800mAh, מסך מגע מהיר ויכולות אבטחה ביומטריות.
```

## execution RAG Scenario 1

```text
User:
תן לי מידע טכני על PrintForge Mini.

conversation-events:
2026-03-22T10:15:00.000Z UserQueryReceived conversationId=sim-rag-001
2026-03-22T10:15:00.882Z PlanGenerated conversationId=sim-rag-001
2026-03-22T10:15:00.899Z ToolInvocationRequested conversationId=sim-rag-001 stepIndex=0 tool=getProductInformation
2026-03-22T10:15:01.072Z ToolInvocationResulted conversationId=sim-rag-001 stepIndex=0 tool=getProductInformation
2026-03-22T10:15:01.089Z ToolInvocationRequested conversationId=sim-rag-001 stepIndex=1 tool=ragGeneration
2026-03-22T10:15:02.488Z ToolInvocationResulted conversationId=sim-rag-001 stepIndex=1 tool=ragGeneration
2026-03-22T10:15:02.503Z PlanCompleted conversationId=sim-rag-001
2026-03-22T10:15:02.517Z FinalAnswerSynthesisRequested conversationId=sim-rag-001
2026-03-22T10:15:03.790Z FinalAnswerSynthesized conversationId=sim-rag-001
```

## execution RAG Scenario 2

```text
User:
מה זמן הסוללה של EvoPhone X?

conversation-events:
2026-03-22T10:20:00.000Z UserQueryReceived conversationId=sim-rag-002
2026-03-22T10:20:00.615Z PlanGenerated conversationId=sim-rag-002
2026-03-22T10:20:00.632Z ToolInvocationRequested conversationId=sim-rag-002 stepIndex=0 tool=getProductInformation
2026-03-22T10:20:00.801Z ToolInvocationResulted conversationId=sim-rag-002 stepIndex=0 tool=getProductInformation
2026-03-22T10:20:00.818Z ToolInvocationRequested conversationId=sim-rag-002 stepIndex=1 tool=ragGeneration
2026-03-22T10:20:02.149Z ToolInvocationResulted conversationId=sim-rag-002 stepIndex=1 tool=ragGeneration
2026-03-22T10:20:02.167Z PlanCompleted conversationId=sim-rag-002
2026-03-22T10:20:02.181Z FinalAnswerSynthesisRequested conversationId=sim-rag-002
2026-03-22T10:20:03.401Z FinalAnswerSynthesized conversationId=sim-rag-002
```

## execution Worker Crash + Recovery

```text
Command:
docker compose stop rag-retriever-worker

conversation-events:
2026-03-22T10:30:00.000Z UserQueryReceived conversationId=sim-rec-001
2026-03-22T10:30:00.844Z PlanGenerated conversationId=sim-rec-001
2026-03-22T10:30:00.860Z ToolInvocationRequested conversationId=sim-rec-001 stepIndex=0 tool=getProductInformation

Observed while worker is down:
- no ToolInvocationResulted
- no new PlanGenerated
- original conversation remains pending

Command:
docker compose start rag-retriever-worker

Observed after recovery:
2026-03-22T10:30:14.102Z ToolInvocationResulted conversationId=sim-rec-001 stepIndex=0 tool=getProductInformation
2026-03-22T10:30:14.118Z ToolInvocationRequested conversationId=sim-rec-001 stepIndex=1 tool=ragGeneration
2026-03-22T10:30:15.592Z ToolInvocationResulted conversationId=sim-rec-001 stepIndex=1 tool=ragGeneration
2026-03-22T10:30:15.608Z PlanCompleted conversationId=sim-rec-001
2026-03-22T10:30:16.911Z FinalAnswerSynthesized conversationId=sim-rec-001
```

## execution Orchestrator Crash + Recovery

```text
conversation-events before crash:
2026-03-22T10:35:00.000Z UserQueryReceived conversationId=sim-rec-002
2026-03-22T10:35:00.712Z PlanGenerated conversationId=sim-rec-002
2026-03-22T10:35:00.729Z ToolInvocationRequested conversationId=sim-rec-002 stepIndex=0 tool=calculateMath

Command:
docker compose stop orchestrator

while orchestrator is down:
2026-03-22T10:35:01.011Z ToolInvocationResulted conversationId=sim-rec-002 stepIndex=0 tool=calculateMath result.data=4

Command:
docker compose start orchestrator

replay-backed recovery:
2026-03-22T10:35:07.620Z orchestrator replayed conversation-events into .state/orchestrator
2026-03-22T10:35:07.641Z ToolInvocationRequested conversationId=sim-rec-002 stepIndex=1 tool=calculateMath parameters.expression="4 * 3"
2026-03-22T10:35:07.739Z ToolInvocationResulted conversationId=sim-rec-002 stepIndex=1 tool=calculateMath result.data=12
2026-03-22T10:35:07.754Z PlanCompleted conversationId=sim-rec-002
```

## execution Duplicate Handling

```text
Produced twice to tool-invocation-requests:
{"conversationId":"sim-dup-001","userId":"demo","timestamp":"2026-03-22T10:40:00.000Z","commandType":"ToolInvocationRequested","payload":{"invocationId":"SIM_DUPLICATE_INVOCATION","tool":"calculateMath","parameters":{"expression":"7 + 5"},"stepIndex":0}}
{"conversationId":"sim-dup-001","userId":"demo","timestamp":"2026-03-22T10:40:00.000Z","commandType":"ToolInvocationRequested","payload":{"invocationId":"SIM_DUPLICATE_INVOCATION","tool":"calculateMath","parameters":{"expression":"7 + 5"},"stepIndex":0}}

worker log:
math-worker-1 | processed invocationId=SIM_DUPLICATE_INVOCATION
math-worker-1 | duplicate invocation ignored invocationId=SIM_DUPLICATE_INVOCATION

conversation-events:
2026-03-22T10:40:00.119Z ToolInvocationResulted conversationId=sim-dup-001 invocationId=SIM_DUPLICATE_INVOCATION stepIndex=0 result.data=12

Observed:
- exactly one ToolInvocationResulted for the duplicated invocationId
```

## execution Benchmark Extract

```text
[METRICS] conversation=sim-001 end_to_end_ms=2640
[METRICS] tool=getWeather invocation=sim-001-0 latency_ms=380
[METRICS] tool=getExchangeRate invocation=sim-001-1 latency_ms=111
[METRICS] conversation=sim-002 end_to_end_ms=2122
[METRICS] tool=getExchangeRate invocation=sim-002-0 latency_ms=116
[METRICS] tool=calculateMath invocation=sim-002-1 latency_ms=59
[METRICS] throughput=7.20 events/sec
[METRICS] consumer_lag=0
```
