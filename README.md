# Build AI-Powered Apps

This repository is an extension of https://github.com/mosh-hamedani/ai-powered-apps-course and includes the source files from that project, plus local additions.

This repository contains the complete source code for the course **Build AI-Powered Apps**:

https://codewithmosh.com/p/build-ai-powered-apps


## Local setup (Final Project: Tool Orchestration + RAG)

1) Install Bun: https://bun.sh  
2) Install dependencies (repo root):

```
bun install
```

3) Create `packages/server/.env`:

```
OPENAI_API_KEY=sk-...
WEATHER_API_KEY=...
RAG_SERVICE_URL=http://localhost:8000
```

4) Start Python RAG service (separate terminal):

```
cd python-service
python3 index_kb.py
uvicorn server:app --host 0.0.0.0 --port 8000
```

5) Run server (separate terminal):

```
cd packages/server
bun run dev
```

6) Run client (separate terminal):

```
cd packages/client
bun run dev
```

Client: http://localhost:5137  
Server: http://localhost:3000  
RAG Service: http://localhost:8000

Router features:
- The server generates tool plans (JSON) and orchestrates multi-step execution.
- General chat uses Llama3; planning falls back to OpenAI if JSON is invalid.
- Use `/reset` to clear the saved history.
- Review-only prompts run quick sentiment + analysis unless a product spec is requested, in which case the router handles it.

Folder structure (key parts):
- `packages/server` — TypeScript orchestration server
- `packages/client` — React UI
- `python-service` — RAG indexing + retrieval API
- `data/products` — KB text files
- `execution-log.md` — proof logs

Python dependencies:
- `python-service/requirements.txt`



Real demo timings (from latest `execution-log.md`)

| Operation | Module | Duration (ms) | Precision (1-5) |
|---|---|---:|---:|
| Router (math) | OpenAI | 1202 | 5 |
| Router (weather+fx) | OpenAI | 1206 | 5 |
| Synthesis (weather+fx) | OpenAI | 2497 | 5 |
| RAG Retrieval (EvoPhone X) | Python/Chroma | 318 | 5 |
| RAG Generation (EvoPhone X) | OpenAI | 1245 | 5 |
| RAG Retrieval (PrintForge) | Python/Chroma | 115 | 5 |
| RAG Generation (PrintForge) | OpenAI | 4700 | 5 |

Model comparison note:
- Router prefers local Ollama for speed/cost; OpenAI is fallback for strict JSON reliability.


---

<div dir="rtl">

## ניתוח המערכת ומענה על שאלות הפרויקט

### 1. נימוקי בחירת מודלים וארכיטקטורה

**Orchestration (Router) - Llama3 עם fallback לענן**
* **בחירה:** Llama3 (מקומי) -> OpenAI GPT-4o-mini (ענן) במקרה כשל.
* **נימוקים:**
    * **מהירות:** הכתיבה הראשונה משתמשת ב-Llama3 כדי להחליט לאילו כלים לקרוא. תיאורטית זה קריטי לחוויה של המשתמש (מהר יותר מענן). במקרה שלנו בגלל שימוש במחשבים ביתיים מוגבלים ביכולתם לעומת ענן בשווי מיליארדי דולרים הטיעון לא ממומש.
    * **עצמאות:** לא תלוי בחיבור לאינטרנט או בזמינות של API ענן.
    * **Fallback חזק:** אם Llama3 מנותק או נכשל בפרסום JSON, עוברים ל-OpenAI עם `responseFormat: {type: 'json_object'}` שמבטיח JSON תקין.

**RAG (חיפוש + הנדסת ידע)**
* **חיפוש:** שימוש במודל מקומי לחלוטין (Sentence-Transformers).
* **ניתוח:** GPT-4o-mini בענן.
* **נימוקים לחיפוש מקומי (python-service):**
    * מודל: `sentence-transformers/all-MiniLM-L6-v2` + ChromaDB.
    * יתרונות: ללא תשלום (מודל חופשי, קוד פתוח), קביעה מקומית שלא משתנה עם הזמן (מערכת סגורה של מוצרים), זמינות תמיד ללא אינטרנט, ומהירות מספיקה (~50-100ms).
* **ניתוח בענן (GPT-4o-mini):**
    * צריך הבנה עמוקה של הקשר + טקסט המוצר + שאלת המשתמש. Llama3 עלול להיות פחות מדויק עם טקסט מורכב. מידת הביצוע חשובה יותר מהמהירות במקרה זה.

**General Chat - Llama3 עם fallback לענן**
* **בחירה:** Llama3 (מקומי) → GPT-4o-mini (ענן).
* **נימוקים:** שיחה כללית שלא כרוכה בידע ספציפי ולכן Llama3 מספיק. מאפשר חוויה שלא תלויה בענן עבור 80% מהשיחות.

### 2. Microservices - השפעה על ביצועים, עלות וגמישות

**ביצועים (Performance):**
* זרימה כוללת של Session מורכב לוקחת בערך 1.3 שניות.
* בהשוואה למונוליט (הכל ב-TypeScript) שהיה לוקח 1.2 שניות, ישנה תקורה (overhead) של כ-100 מילישניות בגלל תקשורת רשת.
* יתרון: Python Embeddings לא חוסם את ה-TypeScript, ואפשר להריץ מספר בקשות RAG בו-זמנית.

**עלות (Cost):**
* זיכרון תשתית: מונוליט דורש כ-1GB, בעוד Microservices דורשים כ-1.5GB (עקב מודל ה-Transformers ו-ChromaDB בפייתון).
* עלות API: בערך $0.0003 לשאילתה מורכבת.
* יתרון: סקלאביליות נפרדת לכל שירות. אם צריך יותר חיפושי RAG, מוסיפים רק Python instances.

**גמישות (Flexibility):**
* בידוד תקלות: אם שירות הפייתון נופל, ה-TypeScript עדיין עובד ומחזיר תשובה בסיסית.
* תחזוקה: ניתן לעדכן את מודל ה-Embeddings מבלי לעשות deploy מחדש לכל המערכת.
* בחירה טכנולוגית: מאפשר שימוש בספריות שהן Python-native (כמו Sentence-Transformers) בצורה טבעית.

### 3. אתגרים ופשרות (Trade-offs) העיקריים

* **אמינות מול זמינות:** במודלים חינמיים בענן יש הגבלות קצב (Rate Limits), ובמודלים מקומיים האמינות תלויה בכוח העיבוד של המחשב. הפשרה היא חיסכון בעלויות לחלוטין אך סיכון שהבוט יחזיר תשובה חלקית בעומס גבוה.
* **דיוק הניתוב:** מודלים קטנים/חינמיים נוטים יותר ל"הזיות" בבניית תוכנית (Plan). הפשרה הצריכה כתיבת לוגיקת "תיקון עצמי" ב-TypeScript לווידוא תקינות הפלט.
* **ביצועים:** מודלים חינמיים בענן איטיים יותר לעיתים, מה שמשפיע על זמן התגובה הכולל בתמורה לנגישות ללא תקציב.

### 4. הצעות לשיפורים עתידיים

* **שימוש במודלים מקומיים קלים (Quantization):** למשל ב-Ollama, כדי להריץ את ה-Router מהר יותר על החומרה הקיימת.
* **מנגנון Retry חכם:** מעבר אוטומטי למודל מקומי אחר אם אחד מחזיר שגיאת עומס.
* **שיפור הנדסת הפרומפט:** חידוד הפרומפטים כך שיהיו קשיחים יותר (Strict) למניעת טעויות פורמט במודלים פשוטים.
* **Caching מקומי של Embeddings:** שמירת וקטורים שחושבו כבר כדי לחסוך זמן עיבוד בשאילתות חוזרות ב-ChromaDB.


</div>


operation                      | module       | duration (ms) | precise | price

Router                         | ollama       | 9050          | 5       | FREE
Router Fallback                | OpenAi       | 2869          | 5       | under token limit
General chat                   | ollama       | 18889         | 5       | FREE
Review sentiment               | OpenAi       | 1106          | 5       | FREE
Review Analysis                | OpenAi       | 2783          | 5       | under token limit
RAG retrival                   | all-MiniLM-L6-v2 | 616           | 5       | FREE
RAG Generation                 | OpenAi       | 4368          | 5       | under token limit
Orchestration Synthesis        | OpenAi       | 1193          | 5       | under token limit