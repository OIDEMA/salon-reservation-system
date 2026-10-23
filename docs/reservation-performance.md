# Reservation list and search performance

The Tokyo production frontend and API use the same authorization boundaries as the reservation management screens. Measure authenticated reservation work separately from public login HTML or `/ready`: those public endpoints do not include the reservation query, tenant authorization, JavaScript execution, or rendering.

## Request-local authorization reuse

The API permission hook and its route handler can both require the tenant context. A successful identity and tenant/salon resolution is reused only within that exact Fastify request, provided its authorization and scope headers still match. Each subsequent HTTP request checks Firebase revocation, the current application user, membership, tenant, and salon again. Role restrictions are evaluated on every call. Changing the credential or tenant/salon headers requires the corresponding checks again; a denied scope is not retained as a successful context.

This removes duplicate credential verification, user updates, membership reads and salon resolution from the same reservation list/search request. It does not cache reservation results, share authorization between requests, or change transactional write authorization checks.

## First reservation-board display

An authorized HTML document request fetches its initial dashboard on the server. The response includes the reservation cards before client effects run, and hydration reuses that exact tenant/salon/date response without another dashboard request. JavaScript and data retrieval no longer form a sequential browser request chain for the initial board.

Client navigation and RSC requests keep a fresh client fetch. Initial data is invalidated after date, search, status, refresh, mutation, tenant, salon or permission changes, and when a later server render arrives. Cached navigation payloads cannot re-enable a consumed initial response. Failed preloads retain the existing client retry, while authentication and authorization redirects are rethrown.

## Verification record

The request-local optimization was compared over 20 synthetic HTTP requests through a Fastify permission hook and handler. Firebase revocation verification, user updates, membership reads and salon resolution each fell from 40 calls to 20. This is a 50% reduction in those dependencies only; it is not a measured 50% reduction in overall SQL count or production response time.

The isolated PostgreSQL 16 integration build `30ba9315-d959-48dc-a491-d9178c09157e` passed 145 tests, including list/search correctness, pagination, tenant/salon isolation and the actual reservation route's single credential verification. Request-local guard tests additionally cover stricter permissions, scope changes and revocation on the next HTTP request. A production Next.js build with a local synthetic API verified initial HTML cards, document-only preloading, private/no-store responses, permission exclusions, fallback and authentication redirects.

## Measurement protocol

1. Use an existing authorized login at the Tokyo production URL. Keep the tenant, salon, date range, result page size, and search terms identical before and after a release. Do not create reservations or modify customer data for timing checks.
2. Measure opening the reservation board, opening reservation search, applying a matching search, an empty result search, changing date/status, and paging. Record navigation or submit start, response completion, and the first painted settled results separately.
3. Keep first visits separate from repeated visits. Repeat each case at least ten times with a pause between requests. Report sample count, median and p95, browser/cache conditions, measurement date, and revision. A single first request is not evidence of a cold start.
4. Preserve only timings, statuses, generic scenario names, result counts and revision identifiers. Do not persist session cookies, tokens, customer names, search text, response bodies, or clinical information in performance evidence.
5. Compare counts and results as well as timing. Check tenant/salon isolation, revoked and disabled users, restricted memberships, pagination, date/status filters, and cancellation of stale searches. Run the PostgreSQL integration suite against its disposable PostgreSQL 16 database rather than production data.

Cloud Run request latency can supplement these measurements, but it does not measure browser rendering. An empty authenticated-success sample must be recorded as unavailable, rather than a zero response time or a speed improvement.
