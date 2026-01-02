# Build AI-Powered Apps

This repository is an extension of https://github.com/mosh-hamedani/ai-powered-apps-course and includes the source files from that project, plus local additions.

This repository contains the complete source code for the course **Build AI-Powered Apps**:

https://codewithmosh.com/p/build-ai-powered-apps

I have designed this course to teach you everything you need to know to confidently bring AI into your applications. In this course, you’ll learn how to:

- Understand large language models (LLMs) and how they work  
- Work with tokens, context windows, and model settings  
- Write effective prompts using proven prompt engineering techniques  
- Build a chatbot from scratch with a clean, maintainable architecture  
- Create a product review summarizer to help users make faster decisions  
- Integrate open-source models from Hugging Face and Ollama  
- Run models locally on your own machine  
- Apply clean code principles and best practices  
- Use modern tools to build full-stack AI-powered applications  

By the end of this course, you’ll not only understand the foundations of AI models, but you’ll also have the skills and confidence to build real, production-ready AI-powered features that solve real-world problems.


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
HF_TOKEN=...
```

5) Run migrations:

```
cd packages/server
bunx prisma migrate deploy
```

6) Run the app (client + server):

```
cd ../..
bun run dev
```

Client: http://localhost:5173
Server: http://localhost:3000
