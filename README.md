# Salon Reservation System

Next.js frontend + Fastify API + Prisma + PostgreSQL for a salon reservation operations console.

## Apps

- `apps/web`: Next.js admin frontend
- `apps/api`: Fastify API, Prisma schema, seed data
- `docker-compose.yml`: local PostgreSQL

## Quick Start

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

- Frontend: http://localhost:3000
- API: http://localhost:4001
- Health check: http://localhost:4001/health

The frontend includes a resilient demo-data fallback, so the interface still opens while PostgreSQL is being prepared.

## Deploy Notes

This repository is a monorepo. The frontend and API can be deployed as separate services from the same GitHub repository.

Frontend:

```txt
Root directory: apps/web
Build command: npm run build
Environment: NEXT_PUBLIC_API_BASE_URL=https://your-api.example.com
```

API:

```txt
Root directory: apps/api
Build command: npm run build
Start command: npm run start
Environment: DATABASE_URL=postgresql://...
```
