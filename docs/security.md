# Security maintenance

## Dependency and runtime updates

Run `npm run audit:security` from the repository root. This checks all three lock files: the development workspace, standalone API container, and standalone App Hosting frontend. Cloud Build runs the same check before deployment and fails on reported vulnerabilities of any severity. Review upstream advisories as well: the npm advisory feed may lag the framework publisher.

The 2026-10-22 update uses Next.js 16.4.2, Fastify 5.12.7, Firebase 12.19.0 and Firebase Admin 14.5.0. Next.js includes the fixes described in its [October security update](https://nextjs.org/blog/nextjs-security-update-october-14-2026). The API and validation images use Node.js 22.23.4; see [deployment verification](native-deployment.md) for the independent App Hosting runtime check.

The following overrides are intentional and must remain consistent between workspace and standalone manifests:

- `@firebase/firestore` → `@grpc/grpc-js ^1.14.6`: replaces Firestore's old 1.9 dependency with a patched 1.x client. See [gRPC advisory](https://github.com/grpc/grpc-node/security/advisories/GHSA-m9gg-hp2v-232j).
- `@prisma/config` → `deepmerge-ts 8.0.0`: fixes recursive graph stack exhaustion while retaining Prisma/Prisma Client 6.19.3. Version 8 changes Map merging and some TypeScript names; this application uses schema-based configuration, and Prisma generation/validation and application type checks pass. Re-evaluate when changing Prisma configuration. See [release notes](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0).
- `@firebase/app 0.16.2`: matches Firebase 12.19.0's exact dependency and prevents a second App registry from being selected through peers. Without this alignment the production prerender failed with “Component auth has not been registered yet”. Verify both workspace and standalone builds when upgrading Firebase.

## Request protection

Cookie-authenticated backend proxies validate the request origin before reading or forwarding mutation bodies. An explicit Origin must match the request origin or configured public origins. If Origin is absent, a same-origin Referer or Fetch Metadata indication is required. Cross-site, opaque, and unproven requests are rejected with HTTP 403. Read methods keep their existing authentication behavior.

The legacy password-status endpoint returns the same uncached response for all valid email inputs, without querying account records. Initial password setup and recovery use the shared `/password-reset` flow. See [tenant authentication](tenancy.md) for provider-level email enumeration protection.

Local PostgreSQL binds to 127.0.0.1. Never use a production database for integration tests. DB integration and container execution require an available local PostgreSQL server or Docker daemon; unit tests and a successful build alone do not replace those checks.
