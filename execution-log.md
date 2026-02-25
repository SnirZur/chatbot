# Execution Log

Session 1
User: כמה חם בתל אביב?
Bot: 22 מעלות, מעונן חלקית.
User: כמה זה דולר בשקלים?
Bot: שער הדולר היציג הוא 3.75 ש"ח
User: כמה זה 150 ועוד 20?
Bot: התוצאה היא 170
User: ספר לי משהו מעניין על החלל.
Bot: החלל עצום ורובו מורכב מחלל ריק, ובכל זאת הוא מכיל מיליארדי גלקסיות.

(Stopped the program)

Session 2
System: ברוך שובך! טענתי את היסטוריית השיחה הקודמת.
User: אתה זוכר מה שאלתי קודם על הדולר?
Bot: כן, שאלת כמה זה דולר בשקלים, והשבתי ששער הדולר היציג הוא 3.75 ש"ח.

## Resilience Demos

### Worker Crash + Recovery (tool-worker)
Command:
```
docker compose stop tool-worker
```
User: מה מזג האוויר בתל אביב?
Bot: (timeout / no response)

Command:
```
docker compose start tool-worker
```
User: מה מזג האוויר בתל אביב?
Bot: 22 מעלות, מעונן חלקית.

### Orchestrator Crash + Recovery
Command:
```
docker compose stop orchestrator
```
User: ליוסי יש 200 ש"ח ומוצר עולה 25 דולר — כמה יישאר לו אחרי ההמרה והקנייה?
Bot: (timeout / no response)

Command:
```
docker compose start orchestrator
```
User: ליוסי יש 200 ש"ח ומוצר עולה 25 דולר — כמה יישאר לו אחרי ההמרה והקנייה?
Bot: ליוסי יישארו 106.25 ש"ח אחרי ההמרה והקנייה.

### Duplicate Invocation (Idempotency)
Action: resend the same ToolInvocationRequested event (same invocationId).
Result: tool-worker ignores duplicate invocationId, no duplicated ToolInvocationResulted event emitted.
