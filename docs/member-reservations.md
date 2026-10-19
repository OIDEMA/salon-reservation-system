# BeautyGum member reservation API

This is the canonical contract for the implemented `/api/member/*` endpoints. Implementation: `apps/api/src/member-auth.ts`, `member-booking-domain.ts`, `member-booking-routes.ts`, and `reservation-capacity.ts`.

The member app books against the same reservations and staff capacity as the salon management application. This release uses `paymentMode: "pay_at_salon"`: new app reservations are confirmed and unpaid. It does not create Stripe payments or award membership points.

## Authentication and data boundaries

Use the reservation API's HTTPS origin with `Authorization: Bearer <Firebase ID Token>`. Tokens must belong to `salon-reserve-bg`; the API verifies their signature, expiry and revocation and checks the expected issuer/audience. Anonymous accounts are rejected. A verified email address or verified phone identity is required. Staff session cookies, preview actor headers, static member numbers and shared app keys are not member credentials.

The API derives the member's project and UID from the verified token. Tenant/salon routing headers used by the staff application do not select the member's identity or grant access. Request bodies cannot select a UID or arbitrary customer ID. Every member response uses `Cache-Control: private, no-store` and `Pragma: no-cache`.

`MemberCustomerLink` maps the verified project/UID to a customer within one tenant and salon. The first booking in a salon creates a separate customer and link; names, phone numbers and email addresses never automatically claim an existing or imported customer. A later successful new booking updates only that linked customer's name, kana and phone. Internal notes, tags, statistics and other customers remain unchanged. Legacy-customer linking requires a separate verified workflow.

Reservation reads, cancellation and both idempotent replay paths recheck current customer ownership and active, published tenant scope. A management-side customer reassignment can therefore remove the original member's access, including access through an old retry key. Responses contain no customer contact records, staff notes, clinical charts, risk scores or audit metadata. Historical import snapshots are not automatically exposed to members.

The app keeps passwords and ID tokens in memory. Native refresh sessions use SecureStore and a non-secret logout marker to prevent restoration after a failed secure deletion; browser previews keep sessions in memory. No shared bearer token or service-account key belongs in client configuration.

## Publication and availability

The production deployment script configures:

```text
MEMBER_BOOKING_TENANTS=mens-gentle:gentle;missmrs-takamatsu:missmrs
```

Entries are semicolon-separated `<tenant-slug>:<brand-id>` pairs, with `gentle`, `missmrs` or `antiage` as the brand. Empty, malformed or duplicate mappings publish no salons. Only active mapped tenants with supported JST salon settings are returned. See [native-deployment.md](native-deployment.md) for the deployment pipeline.

The catalog exposes active, public menus and active non-resource staff. An explicitly disabled menu category suppresses its menus. Staff eligibility currently means the same salon, an active record and a non-`ROOM_RESOURCE` role; the master schema does not contain individual staff/menu skill assignments.

A bookable time must satisfy configured JST business hours, closed days/holidays, the booking window (at most 180 days), reservation cutoff and candidate interval. An explicit `AVAILABLE` shift must cover the full treatment. `OFF`, `BREAK`, `SALES_STOP` and `TRAINING` blocks prevent the affected staff/salon interval. No registered working shifts means no self-service availability; deployment does not invent production shifts.

Member creation and staff create/edit/status changes take the same scoped salon lock and run the final capacity check in the transaction. Peak simultaneous occupancy respects the salon limit and each staff member's `parallelCapacity`. `PENDING`, `CONFIRMED`, `ARRIVED` and `COMPLETED` reservations occupy their stored intervals; adjacent intervals do not overlap. Creation and cancellation recheck the current clock after lock waits and immediately before the write, so crossing a cutoff aborts the transaction.

## Endpoints

All request JSON is strict: unsupported fields return `400 INVALID_INPUT`. Error responses have the shape `{ "code": "...", "message": "..." }`.

### GET /api/member/catalog

Returns:

```ts
{
  paymentMode: "pay_at_salon";
  salons: Array<{
    id: string; tenantSlug: string; brandId: "gentle" | "missmrs" | "antiage";
    name: string; timeZone: "Asia/Tokyo"; acceptingReservations: boolean;
    bookingWindowDays: number; openTime: string; closeTime: string;
    candidateIntervalMinutes: number;
    menus: Array<{ id: string; name: string; category: string; description: string; durationMinutes: number; price: number }>;
    categories: Array<{ id: string; name: string }>;
    staff: Array<{ id: string; name: string; nominationFee: number; imageUrl: string | null }>;
  }>;
}
```

The catalog is bounded to 50 salons, 500 menus and 100 staff per salon, with bounded category queries. Catalog menu prices exclude nomination fees; availability slots contain the total for their assigned staff member.

### GET /api/member/availability

Query: `salonId`, `serviceId`, `date=YYYY-MM-DD`, and optional `staffId`. The date is a single JST calendar day within the configured booking window.

```ts
{
  salonId: string; serviceId: string; date: string; timeZone: "Asia/Tokyo";
  paymentMode: "pay_at_salon";
  slots: Array<{
    id: string; startTime: string; endTime: string; startsAt: string; endsAt: string;
    staffId: string; staffName: string; price: number; durationMinutes: number;
  }>;
}
```

Times are `HH:mm`; timestamps are ISO 8601 with a timezone. Each slot is staff-specific. Omitting `staffId` returns eligible staff slots; creation still requires the selected slot's explicit staff ID. A slot's `id` is a stable selection identifier, not an authorization token or a hold. Availability returns no customer data. If the bounded schedule read exceeds 5,000 shifts or reservations, it fails with `409 SLOT_UNAVAILABLE` rather than calculating from incomplete data.

### GET /api/member/reservations

Query: `page` (default 1, range 1–10,000) and `pageSize` (default 20, range 1–50).

```ts
{
  reservations: MemberReservation[];
  page: number; pageSize: number; total: number; totalPages: number;
  paymentMode: "pay_at_salon";
}
```

The API filters by current ownership and publication before paginating, ordered by `startsAt DESC, id DESC`. All reservation statuses are included. `totalPages` is at least 1, including an empty result. The frontend does not download another member's reservations or filter an entire salon's data locally.

### POST /api/member/reservations

Required header: `Idempotency-Key: <UUID>`. Generate a new UUID for a new intended booking and reuse the same UUID and complete payload for uncertain network retries.

```json
{
  "salonId": "salon-id",
  "serviceId": "service-id",
  "staffId": "staff-id",
  "expectedPrice": 5500,
  "expectedDurationMinutes": 60,
  "date": "2026-11-01",
  "startTime": "10:00",
  "customer": { "name": "予約 会員", "kana": "ヨヤク カイイン", "phone": "09000000000" }
}
```

`expectedPrice` and `expectedDurationMinutes` are required comparison preconditions from the selected availability slot. They never set the price, duration or payment state. The server resolves the current public menu and staff record, computes `service.price + staff.nominationFee`, and uses the server's service duration. A mismatch returns `409 PRICE_CHANGED` or `409 DURATION_CHANGED` and creates no booking. Refresh availability and obtain confirmation of the changed details before submitting again.

Identifiers are bounded strings. Price expectations are integer yen from 0 through 110,000,000, duration expectations are integers from 1 through 1,440 minutes, and name/kana are trimmed 1–100-character strings without control characters. Phone values must contain 10–15 digits and may include the accepted formatting characters. Extra fields such as `price`, `amount`, `paymentStatus`, `status`, `customerId`, `uid` or `tenantId` are rejected.

A new booking returns `201 { reservation: MemberReservation, paymentMode: "pay_at_salon" }`. A committed retry returns `200` with the same reservation ID and its current state, after checking current ownership and publication. Reusing a key with a different canonical payload, including different expected price/duration, returns `409 IDEMPOTENCY_CONFLICT`.

`MemberReservationRequest` stores the owner-scoped key, payload hash and server-agreed price including nomination fees. That price remains stable after menu/staff price changes and is used by the app reservation DTO, management views and initial/reopened checkout. The reservation's stored start/end timestamps determine its displayed duration. A retry creates neither a second reservation nor a second customer.

### POST /api/member/reservations/:id/cancel

Body: `{}`. Returns `200 { reservation: MemberReservation, paymentMode: "pay_at_salon" }`.

Cancellation requires current ownership in an active published tenant, a future `PENDING`, `CONFIRMED` or `WAITLIST` reservation, an open cancellation cutoff, `UNPAID` payment state, and no treatment chart or finalized checkout. Already-cancelled repeats return the current reservation safely. A non-owner or unpublished reservation returns `404`; a disallowed state/cutoff/payment returns `409 CANCELLATION_UNAVAILABLE`. No payment refund is fabricated.

## MemberReservation

```ts
type MemberReservation = {
  id: string; salonId: string; salonName: string; tenantSlug: string;
  brandId: "gentle" | "missmrs" | "antiage";
  serviceId: string; serviceName: string; category: string;
  staffId: string | null; staffName: string | null;
  date: string; startTime: string; endTime: string; startsAt: string; endsAt: string;
  durationMinutes: number; price: number;
  status: "PENDING" | "CONFIRMED" | "ARRIVED" | "COMPLETED" | "CANCELLED" | "NO_SHOW" | "WAITLIST";
  paymentStatus: "UNPAID" | "AUTHORIZED" | "PAID" | "REFUNDED";
  paymentMode: "pay_at_salon"; canCancel: boolean; createdAt: string; updatedAt: string;
};
```

For app-created reservations, `price` is the server-held booking snapshot. A staff-created reservation attached to a linked customer and lacking that snapshot uses the current service price plus the current staff nomination fee in this member DTO. No customer contact or internal record fields are returned.

## Limits and errors

Schema-valid new submissions are limited to 10 attempts per project/UID per fixed 10-minute database window. Invalid service/scope and unavailable-slot attempts consume the limit; already committed matching retries do not. Counters older than one day for that UID are removed on later attempts. One identity may have at most eight future `PENDING`, `CONFIRMED`, `ARRIVED` or `WAITLIST` reservations across its linked salons.

Creation uses an identity advisory lock followed by Tenant and Salon locks. The `MemberBookingRateLimit` attempt counter commits separately, so a rejected booking cannot roll it back. No bearer tokens are stored in request/counter records or audit entries.

| HTTP | Codes |
| --- | --- |
| 400 | `INVALID_INPUT`, `INVALID_DATE`, `INVALID_SERVICE`, `INVALID_STAFF`, `INVALID_RESERVATION_TIME` |
| 401 | `UNAUTHENTICATED` |
| 403 | `MEMBER_IDENTITY_REQUIRED` |
| 404 | `SALON_NOT_FOUND`, `RESERVATION_NOT_FOUND` |
| 409 | `PRICE_CHANGED`, `DURATION_CHANGED`, `SLOT_UNAVAILABLE`, `CANCELLATION_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`, `BOOKING_LIMIT`, `RESERVATIONS_SUSPENDED`, `SALON_UNAVAILABLE`, `SALON_CAPACITY_EXCEEDED`, `STAFF_CONFLICT`, `STAFF_UNAVAILABLE` |
| 429 | `BOOKING_RATE_LIMIT` |
| 500 | `REQUEST_FAILED` |

## Validation

From the repository root:

```sh
npm run test:operations
npm run typecheck
```

Database integration tests require `OPERATIONS_TEST_DATABASE_URL` pointing to a disposable loopback database whose name ends in `_test`; never use production. With that variable set, run `npm run test:operations:db`.

`member-auth.test.ts`, `member-booking-domain.test.ts` and `reservation-capacity.test.ts` cover token boundaries, publication, booking rules and capacity calculations. `member-booking.integration.test.ts` covers ownership, reassignment/replay isolation, pricing, profile updates, cutoff crossings and member/staff capacity races. `admin-reservation-capacity.integration.test.ts` covers staff creation, movement and status-change races.
