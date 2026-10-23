import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { processEmailOutbox } from "../src/email-outbox.js";
import { deriveInvitationToken } from "../src/invitation-token.js";
import { SesMailError, type TextEmail } from "../src/ses-mail.js";

const now = new Date("2026-10-23T00:00:00.000Z");

function fakeDatabase(row: Record<string, unknown>, invitation?: Record<string, unknown>) {
  let claimed = false;
  const updates: Record<string, unknown>[] = [];
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
    tenantInvitation: { findFirst: async () => invitation ?? null }
  };
  return { database: database as unknown as PrismaClient, updates };
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
