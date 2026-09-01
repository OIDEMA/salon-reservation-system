# Multi-tenant architecture

## Isolation boundary

`Tenant` is the SaaS customer boundary. A tenant may own multiple salons. Every salon-owned business row stores both `tenantId` and `salonId`.

The following invariants are mandatory:

1. A request is authenticated with a Firebase ID token or Firebase session cookie.
2. The first URL segment (`/{tenantSlug}`) selects an active tenant but never grants access to it.
3. The API verifies an active `TenantMembership` for the authenticated `AppUser` before reading or writing business data.
4. Every business query filters by `tenantId`; salon-level queries also filter by `salonId`.
5. Composite foreign keys prevent a record from referencing a salon, customer, service, or staff member owned by another tenant.
6. Resource identifiers are never authorized by identifier alone.

## Identity and authorization

Firebase Authentication owns credentials and email verification. PostgreSQL owns SaaS authorization.

- `AppUser.firebaseUid` maps a Firebase identity to an application user.
- `TenantMembership` maps users to tenants and carries `OWNER`, `ADMIN`, `MANAGER`, `STAFF`, or `VIEWER` roles.
- A user may belong to multiple tenants.
- Suspended users, memberships, and tenants are rejected by the API.
- Mutations require a write-capable role.

Tenant creation and the first `OWNER` assignment are not self-service. An operator provisions them with the private `tenant:provision` job. The public application exposes login and password setup only; authenticated users without an active membership cannot create a tenant or access business data. See [provisioning.md](provisioning.md).

The web application exchanges a recently issued Firebase ID token for an HttpOnly, Secure, SameSite session cookie. Server-side requests forward that credential to Cloud Run. The Cloud Run API verifies the credential again and performs the membership check; the Next.js proxy is only an optimistic navigation guard.

## Tenant URL and salon selection

After login, `/api/me/tenants` returns only memberships belonging to the authenticated user. Tenant-scoped screens use URLs such as `/{tenantSlug}`, `/{tenantSlug}/calendar`, and `/{tenantSlug}/reservations`. The Next.js server forwards the URL slug as `X-Tenant-Slug`, and the API resolves it through an active membership before accessing business data.

The selected salon remains in an HttpOnly cookie and is forwarded as `X-Salon-ID` only when its selected tenant slug matches the URL. Direct navigation to another authorized tenant therefore falls back to that tenant's first salon instead of reusing a salon from a different tenant. `X-Tenant-ID` remains only as a compatibility fallback for global server routes without a tenant URL.

Tenant slugs are immutable, globally unique routing identifiers and must not be display names. Application and legacy route names are reserved. URL segments and selection headers are routing inputs, not trust boundaries. A forged slug, tenant identifier, or salon identifier is rejected because the API verifies membership and scopes the salon lookup to the verified tenant.

## Audit trail

Security-sensitive mutations write an `AuditLog` containing the tenant, actor, action, resource, IP address, user agent, and timestamp. New mutation endpoints must add an audit event in the same database transaction as the business write whenever practical.

## Development rule

Do not use `findUnique({ where: { id } })`, `update({ where: { id } })`, or `delete({ where: { id } })` for tenant-owned resources. Use compound tenant/salon criteria or a scoped `findFirst`/`updateMany`, then return `404` when no scoped row is affected.
