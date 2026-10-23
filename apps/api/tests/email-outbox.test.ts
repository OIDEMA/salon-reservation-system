import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { processEmailOutbox } from "../src/email-outbox.js";
import { deriveInvitationToken } from "../src/invitation-token.js";
import { SesMailError, type TextEmail } from "../src/ses-mail.js";
import { buildReceiptEmail, RECEIPT_EVENT, type ReceiptSnapshot } from "../src/receipt-email.js";

const now = new Date("2026-10-23T00:00:00.000Z");

function fakeDatabase(row: Record<string, unknown>, invitation?: Record<string, unknown>, checkout?: Record<string, unknown>) {
  let claimed = false;
  const updates: Record<string, unknown>[] = [];
  const checkoutQueries: Record<string, unknown>[] = [];
  const database = {
    $queryRaw: async () => claimed ? [] : (claimed = true, [{ id: row.id }]),
    emailOutbox: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => row,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        Object.assign(row, data);
        return row;
      }
    },
    tenantInvitation: { findFirst: async () => invitation ?? null },
    cashCheckout: { findFirst: async (query: { where: Record<string, unknown> }) => {
      checkoutQueries.push(query);
      return checkout && Object.entries(query.where).every(([key, value]) => checkout[key] === value) ? checkout : null;
    } }
  };
  return { database: database as unknown as PrismaClient, updates, checkoutQueries };
}

function reservationRow(payload: unknown = {
  reservationId: "reservation-1", salonName: "東京店", startsAt: "2026-10-23T04:00:00.000Z",
  serviceName: "カット", tenantSlug: "gentle"
}) {
  return {
    id: "outbox-1", eventKey: "reservation.created:reservation-1", eventType: "reservation.created",
    tenantId: "tenant-1", salonId: "salon-1", recipientEmail: "admin@example.com",
    payload, status: "PROCESSING", attempts: 1
  };
}

test("new booking sends one minimal notification to its captured admin email", async () => {
  const { database, updates } = fakeDatabase(reservationRow());
  const sent: TextEmail[] = [];
  const summary = await processEmailOutbox(database, {
    now: () => now,
    baseUrl: "https://salon-reserve.beauty-gum.jp",
    send: async (message) => { sent.push(message); return { messageId: "ses-1" }; }
  });
  assert.deepEqual(summary, { sent: 1, skipped: 0, retried: 0, failed: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, "admin@example.com");
  assert.match(sent[0]?.text ?? "", /東京店/);
  assert.match(sent[0]?.text ?? "", /2026\/10\/23 13:00/);
  assert.match(sent[0]?.text ?? "", /\/gentle\/reservations/);
  assert.doesNotMatch(sent[0]?.text ?? "", /顧客の電話|顧客メール/);
  assert.equal(updates[0]?.status, "SENT");
  assert.equal(updates[0]?.providerMessageId, "ses-1");
});

const checkoutId = "102e7470-74df-4cab-822f-a3c532a77d00";
const receiptRequestId = "7b1c75ba-41fe-48fe-902f-54b0eb35f035";
function receiptRow() {
  const receipt: ReceiptSnapshot = {
    receiptNumber: checkoutId, issuerName: "東京店", paidAt: "2026-10-23T05:20:00.000Z", treatmentAt: "2026-10-23T04:00:00.000Z",
    timezone: "Asia/Tokyo", recipientName: "山田 花子", description: "施術代として", subtotalYen: 5500, discountYen: 0, taxYen: 500, totalYen: 5500,
    items: [{ label: "カット", quantity: 1, unitPriceYen: 5500, discountYen: 0, taxRate: 10, taxYen: 500, totalYen: 5500 }],
    taxBreakdown: [{ taxRate: 10, taxableTotalYen: 5500, taxYen: 500 }], payments: [{ method: "CASH", amountYen: 5500 }]
  };
  return { id: "outbox-receipt", eventKey: `${RECEIPT_EVENT}:${checkoutId}:${receiptRequestId}`, eventType: RECEIPT_EVENT,
    tenantId: "tenant-1", salonId: "salon-1", recipientEmail: "customer@example.com", status: "PROCESSING", attempts: 1,
    payload: { checkoutId, requestId: receiptRequestId, requestHash: "a".repeat(64), receipt } };
}
function receiptCheckout() {
  return { id: checkoutId, tenantId: "tenant-1", salonId: "salon-1", status: "FINALIZED", totalYen: 999,
    notes: "private changed source notes", reservationSnapshot: { salonName: "changed source store" } };
}

test("receipt sends exactly the previewed immutable snapshot and checks tenant plus salon scope", async () => {
  const row = receiptRow();
  const preview = buildReceiptEmail(row.payload.receipt);
  const { database, updates, checkoutQueries } = fakeDatabase(row, undefined, receiptCheckout());
  const sent: TextEmail[] = [];
  const summary = await processEmailOutbox(database, { now: () => now,
    send: async (message) => { sent.push(message); return { messageId: "receipt-ses" }; } });
  assert.deepEqual(summary, { sent: 1, skipped: 0, retried: 0, failed: 0 });
  assert.deepEqual(sent, [{ to: row.recipientEmail, ...preview }]);
  assert.deepEqual(checkoutQueries, [{ where: { id: checkoutId, tenantId: "tenant-1", salonId: "salon-1" }, select: { id: true, status: true } }]);
  assert.doesNotMatch(sent[0]!.text, /changed source|private/);
  assert.equal(updates[0]?.status, "SENT");
});

test("receipt for reversed or otherwise non-finalized checkout is skipped before SES", async () => {
  for (const status of ["REVERSED", "DRAFT"]) {
    const { database, updates } = fakeDatabase(receiptRow(), undefined, { ...receiptCheckout(), status });
    let sends = 0;
    const summary = await processEmailOutbox(database, { now: () => now,
      send: async () => { sends++; return { messageId: "unexpected" }; } });
    assert.deepEqual(summary, { sent: 0, skipped: 1, retried: 0, failed: 0 });
    assert.equal(sends, 0);
    assert.equal(updates[0]?.lastErrorCode, "CHECKOUT_REVERSED");
  }
});

test("wrong receipt key, receipt number or checkout scope fails without SES", async () => {
  const row = receiptRow();
  const cases = [
    { row: { ...row, eventKey: `${RECEIPT_EVENT}:${checkoutId}:wrong` }, checkout: receiptCheckout() },
    { row: { ...row, salonId: null }, checkout: receiptCheckout() },
    { row: { ...row, payload: { ...row.payload, receipt: { ...row.payload.receipt, receiptNumber: receiptRequestId } } }, checkout: receiptCheckout() },
    { row, checkout: { ...receiptCheckout(), tenantId: "another-tenant" } },
    { row, checkout: { ...receiptCheckout(), salonId: "another-salon" } }
  ];
  for (const invalid of cases) {
    const { database, updates } = fakeDatabase({ ...invalid.row }, undefined, invalid.checkout);
    let sends = 0;
    const summary = await processEmailOutbox(database, { now: () => now,
      send: async () => { sends++; return { messageId: "unexpected" }; } });
    assert.equal(summary.failed, 1);
    assert.equal(sends, 0);
    assert.equal(updates[0]?.lastErrorCode, "INVALID_OUTBOX_SCOPE");
  }
});

test("receipt retry preserves captured recipient and body exactly", async () => {
  const row = receiptRow();
  const attempts: TextEmail[] = [];
  const first = fakeDatabase(row, undefined, receiptCheckout());
  const result = await processEmailOutbox(first.database, { now: () => now, send: async (message) => {
    attempts.push(message); throw new SesMailError("SEND_FAILED", true);
  } });
  assert.equal(result.retried, 1);
  const second = fakeDatabase({ ...row, status: "PROCESSING", attempts: 2 }, undefined, receiptCheckout());
  await processEmailOutbox(second.database, { now: () => now, send: async (message) => { attempts.push(message); return { messageId: "receipt-retry" }; } });
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
});

test("temporary SES failure retains the item with a backoff; rejection fails once", async () => {
  const retry = fakeDatabase(reservationRow());
  const retried = await processEmailOutbox(retry.database, {
    now: () => now, send: async () => { throw new SesMailError("SEND_FAILED", true); }
  });
  assert.equal(retried.retried, 1);
  assert.equal(retry.updates[0]?.status, "PENDING");
  assert.equal(retry.updates[0]?.lastErrorCode, "SEND_FAILED");
  assert.ok((retry.updates[0]?.availableAt as Date) > now);

  const rejection = fakeDatabase(reservationRow());
  const failed = await processEmailOutbox(rejection.database, {
    now: () => now, send: async () => { throw new SesMailError("MESSAGE_REJECTED", false); }
  });
  assert.equal(failed.failed, 1);
  assert.equal(rejection.updates[0]?.status, "FAILED");
  assert.equal(rejection.updates[0]?.lastErrorCode, "MESSAGE_REJECTED");
});

test("invalid outbox payload fails without contacting SES", async () => {
  const { database, updates } = fakeDatabase(reservationRow({ reservationId: "wrong" }));
  let sends = 0;
  const summary = await processEmailOutbox(database, {
    now: () => now, send: async () => { sends++; return { messageId: "unexpected" }; }
  });
  assert.equal(summary.failed, 1);
  assert.equal(sends, 0);
  assert.equal(updates[0]?.status, "FAILED");
});

test("revoked invitation is skipped before SES and valid invitation gets a matching token", async () => {
  const expiresAt = new Date("2026-10-24T00:00:00.000Z");
  const key = "test-secret-key-with-at-least-thirty-two-bytes";
  const previousKey = process.env.INVITATION_TOKEN_KEY;
  process.env.INVITATION_TOKEN_KEY = key;
  try {
    const token = deriveInvitationToken({ id: "invite-1", email: "invitee@example.com", expiresAt });
    const invitation = { id: "invite-1", tenantId: "tenant-1", email: "invitee@example.com", expiresAt,
      revokedAt: null, acceptedAt: null, tokenHash: createHash("sha256").update(token).digest("hex") };
    const row = { id: "outbox-invite", eventKey: "invitation.created:invite-1", eventType: "invitation.created",
      tenantId: "tenant-1", salonId: null, recipientEmail: "invitee@example.com", status: "PROCESSING", attempts: 1,
      payload: { invitationId: "invite-1", tenantName: "東京店", role: "STAFF", expiresAt: expiresAt.toISOString() } };
    const revoked = fakeDatabase({ ...row }, { ...invitation, revokedAt: now });
    let sends = 0;
    const skipped = await processEmailOutbox(revoked.database, {
      now: () => now, send: async () => { sends++; return { messageId: "unexpected" }; }
    });
    assert.equal(skipped.skipped, 1);
    assert.equal(sends, 0);
    assert.equal(revoked.updates[0]?.status, "SKIPPED");

    const active = fakeDatabase({ ...row }, invitation);
    const sent: TextEmail[] = [];
    const result = await processEmailOutbox(active.database, {
      now: () => now, send: async (message) => { sent.push(message); return { messageId: "ses-invite" }; }
    });
    assert.equal(result.sent, 1);
    assert.equal(sent[0]?.to, "invitee@example.com");
    assert.match(sent[0]?.text ?? "", /\/accept-invitation#token=/);
    assert.ok((sent[0]?.text ?? "").includes(token));
    assert.equal(active.updates[0]?.status, "SENT");
  } finally {
    if (previousKey === undefined) delete process.env.INVITATION_TOKEN_KEY;
    else process.env.INVITATION_TOKEN_KEY = previousKey;
  }
});
