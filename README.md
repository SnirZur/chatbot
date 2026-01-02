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
