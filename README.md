# Build AI-Powered Apps

This repository is an extension of https://github.com/mosh-hamedani/ai-powered-apps-course and includes the source files from that project, plus local additions.

This repository contains the complete source code for the course **Build AI-Powered Apps**:

https://codewithmosh.com/p/build-ai-powered-apps


## Local setup

1) Install Bun: https://bun.sh
2) Install dependencies (repo root):

```
bun install
```

3) Start MySQL:

```
docker compose up -d
```

4) Create `packages/server/.env`:

```
OPENAI_API_KEY=sk-...
DATABASE_URL="mysql://jennifer:jennifer@localhost:3306/ai_course"
WEATHER_API_KEY=...
```

5) Run migrations:

```
cd packages/server
bunx prisma migrate deploy
```

6) Generate Prisma client:

```
bunx prisma generate
```

7) Run the app (client + server):

```
cd ../..
bun run dev
```

Client: http://localhost:5137
Server: http://localhost:3000

Router features:
- The server routes weather, math, and exchange-rate queries to local handlers.
- General chat uses the LLM with persisted conversation history.
- Use `/reset` to clear the saved history.




operation                      | module       | duration (ms) | precisement

Router                         | ollama       | 9050          | 5
Router Fallback                | OpenAi       | 2869          | 5
General chat                   | ollama       | 18889         | 5
Review sentiment               | Hugging face | 1106          | 5
Review Analysis                | OpenAi       | 2783          | 5
RAG retrival                   | Hugging face | 616           | 5
RAG Generation                 | OpenAi       | 4368          | 5
Orchestration Synthesis        | OpenAi       | 1193          | 5


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