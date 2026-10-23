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
- Checkout receipt/refund records, cash register opening/closing, and fixed closing reports
- Per-reservation treatment charts with finalized revisions and authenticated before/after photos
- Member invitations, per-action permissions, and salon access limits

See [docs/operations.md](docs/operations.md) for the Japanese operating guide, schema introduction, and database test instructions.

External acquisition and publishing integrations are intentionally out of scope for now. The application does not publish to HOT PEPPER Beauty, manage external reviews or coupons, send LINE/email messages, or process external payments.

## Deploy Notes

The frontend runs on Cloud Run in Tokyo (`asia-northeast1`) at [the production login](https://salon-reserve-web-42401528382.asia-northeast1.run.app/login). The API and private Cloud SQL also run in Tokyo. The former API origin remains available through a compatibility relay so existing member apps keep their reservation idempotency keys. The previous App Hosting URL redirects page visits to the Tokyo frontend; users sign in again because session cookies belong to each hostname.

The native deployment pipeline in [docs/native-deployment.md](docs/native-deployment.md) validates the application, builds unique container images, and applies the schema, API, Tokyo frontend, and App Hosting redirect under a production lease from the same Git SHA. Production GitHub Actions deployment has been removed.

Every push to `main` invokes the enabled trigger through a Developer Connect GitHub event connection, separate from the existing Firebase App Hosting Git source connection. The deployment guide records the configuration and completed native pipeline validation.

App Hosting retains its existing backend and source connection to serve the redirect container. Its independent automatic rollouts remain disabled to preserve deployment ordering. The deployment guide also covers required identities, manual re-runs, and lease recovery conditions.

Tenant provisioning remains a separate, manually invoked administrative workflow; see [docs/provisioning.md](docs/provisioning.md).
