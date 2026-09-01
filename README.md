# Salon Reservation System

Next.js frontend + Fastify API + Prisma + PostgreSQL for a salon reservation operations console.

The application is a multi-tenant SaaS. Firebase Authentication verifies identities, while PostgreSQL stores tenant memberships, roles, salon ownership, and audit logs. See [docs/tenancy.md](docs/tenancy.md) for the isolation rules.

Production Cloud SQL is private-IP only and is reached from Cloud Run through Direct VPC egress. See [docs/infrastructure.md](docs/infrastructure.md) for the network invariants.

## Apps

- `apps/web`: Next.js admin frontend
- `apps/api`: Fastify API and Prisma schema
- `docker-compose.yml`: local PostgreSQL

## Quick Start

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:generate
npm run db:push
npm run dev
```

Firebase Authentication environment variables from `.env.example` are required for login. Email/password accounts must verify their email address before a server session is issued.

Tenant creation and the first owner assignment are operator-managed rather than self-service. See [docs/provisioning.md](docs/provisioning.md).

- Frontend login: http://localhost:3000/login
- Tenant screen: `http://localhost:3000/{tenantSlug}`
- API: http://localhost:4001
- Health check: http://localhost:4001/health

PostgreSQL is the source of truth. When no store has been registered, the application shows an empty state instead of sample data.

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
