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

## Implemented Operations

- Customer directory, customer notes (karte), tags, and reservation history
- Reservation creation, search, editing, status transitions, cancellation, and no-show tracking
- Staff and whole-store shift blocks with reservation conflict and capacity checks
- Persistent salon hours, closure days, booking cutoffs, and reservation acceptance settings
- CRUD for staff, menus, categories, and equipment
- Tenant-scoped roles and audit logs for write operations

External acquisition and publishing integrations are intentionally out of scope for now. The application does not publish to HOT PEPPER Beauty, manage external reviews or coupons, send LINE/email messages, or process external payments.

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
