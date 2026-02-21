# Execution Log (Advanced Final Project)

## Scenario 1: Multi-tool orchestration (weather + exchange)
User: מה מזג האוויר בפריז וכמה הדולר שווה היום?
Events:
- UserQueryReceived
- PlanGenerated
- ToolInvocationRequested(getWeather)
- ToolInvocationResulted(getWeather)
- ToolInvocationRequested(getExchangeRate)
- ToolInvocationResulted(getExchangeRate)
- PlanCompleted
- SynthesizeFinalAnswerRequested
- FinalAnswerSynthesized

Result: "בפריז כרגע 14 מעלות עם עננות חלקית, ושער הדולר היציג הוא 3.75 ש״ח."

## Scenario 2: RAG product info
User: מה תחזוקת BrewMaster 360?
Events:
- UserQueryReceived
- PlanGenerated
- ToolInvocationRequested(getProductInformation)
- ToolInvocationResulted(getProductInformation)
- ToolInvocationRequested(ragGeneration)
- ToolInvocationResulted(ragGeneration)
- PlanCompleted
- SynthesizeFinalAnswerRequested
- FinalAnswerSynthesized

Result: "תחזוקה כוללת שטיפה אחרי שימוש, הסרת אבנית כל 6–8 שבועות, וניקוי מסך מקלחת חודשי."

## Scenario 3: Math + exchange
User: ליוסי יש 100 ש״ח, מוצר X עולה 25 דולר — כמה יישאר לו?
Events:
- UserQueryReceived
- PlanGenerated
- ToolInvocationRequested(getExchangeRate)
- ToolInvocationResulted(getExchangeRate)
- ToolInvocationRequested(calculateMath)
- ToolInvocationResulted(calculateMath)
- PlanCompleted
- SynthesizeFinalAnswerRequested
- FinalAnswerSynthesized

Result: "שער הדולר היציג הוא 3.75 ש״ח. לפי החישוב, יישארו 6.25 ש״ח."

## Resilience Demo: Worker crash
- Start scenario 2
- Stop rag-retriever-worker mid flow
- Plan stuck waiting for ToolInvocationResulted
- Restart worker
- Plan resumes and completes

## Resilience Demo: Orchestrator crash
- Start scenario 3
- Stop orchestrator after first step
- Restart orchestrator
- State restored from LevelDB + conversation-events, plan resumes

## Duplicate Event Demo
- Send the same ToolInvocationRequested twice (same invocationId)
- Worker ignores duplicate; only one ToolInvocationResulted emitted
