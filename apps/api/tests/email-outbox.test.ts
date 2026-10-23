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

test("legacy booking events still send to their captured admin email", async () => {
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

function detailedReservationRow(overrides: Record<string, unknown> = {}) {
  return reservationRow({
    reservationId: "reservation-1", salonName: "東京店", tenantSlug: "gentle", startsAt: "2026-10-23T04:00:00.000Z",
    endsAt: "2026-10-23T04:30:00.000Z", durationMinutes: 30, serviceName: "カット", customerName: "山田 太郎",
    reservationAmountYen: 5500, staffName: "担当 花子", isRequest: true, source: "MINI_APP", status: "CONFIRMED", paymentStatus: "UNPAID", ...overrides
  });
}

test("detailed booking email includes captured name and agreed amount without asserting final sales or points", async () => {
  const { database } = fakeDatabase(detailedReservationRow());
  const sent: TextEmail[] = [];
  const result = await processEmailOutbox(database, { now: () => now, send: async (message) => { sent.push(message); return { messageId: "detailed" }; } });
  assert.equal(result.sent, 1);
  const text = sent[0]!.text;
  for (const line of ["お客様名: 山田 太郎", "日時: 2026/10/23 13:00 ～ 2026/10/23 13:30（30分）", "担当: 担当 花子（指名あり）",
    "予約金額（予定）: 5,500円", "ポイント利用: 会計時に確認", "予約経路: 会員アプリ", "予約状態: 確定", "支払状況: 未払い", "売上は会計時に確定します。"])
    assert.ok(text.includes(line), line);
  assert.doesNotMatch(text, /ポイント利用: 0|売上金額:|電話番号|メールアドレス|メモ/);
});

test("booking email distinguishes an unassigned or unrequested staff and preserves a free menu amount", async () => {
  for (const [staffName, expected] of [[null, "指名なし（未割当）"], ["担当 花子", "担当 花子（指名なし）"]] as const) {
    const { database } = fakeDatabase(detailedReservationRow({ staffName, isRequest: false, reservationAmountYen: 0, source: "PHONE", status: "PENDING" }));
    let text = "";
    await processEmailOutbox(database, { send: async (message) => { text = message.text; return { messageId: "free" }; } });
    assert.ok(text.includes(`担当: ${expected}`)); assert.ok(text.includes("予約金額（予定）: 0円"));
    assert.ok(text.includes("予約経路: 電話")); assert.ok(text.includes("予約状態: 未確認"));
  }
});

test("captured customer and staff names cannot inject extra notification lines", async () => {
  const { database } = fakeDatabase(detailedReservationRow({ customerName: "山田\r\n別の項目: テスト", staffName: "担当\t花子", salonName: "東京\n店" }));
  let email: TextEmail | undefined;
  await processEmailOutbox(database, { send: async (message) => { email = message; return { messageId: "sanitized" }; } });
  assert.ok(email?.text.includes("お客様名: 山田 別の項目: テスト"));
  assert.ok(email?.text.includes("担当: 担当 花子（指名あり）")); assert.doesNotMatch(email!.subject, /[\r\n]/);
});

test("invalid enriched booking snapshots fail without sending or falling back to legacy data", async () => {
  for (const overrides of [{ reservationAmountYen: -1 }, { customerName: "" }, { source: "FORGED" }, { durationMinutes: 60 }, { phone: "090-1234-5678" }]) {
    const { database, updates } = fakeDatabase(detailedReservationRow(overrides));
    let sends = 0;
    const result = await processEmailOutbox(database, { send: async () => { sends++; return { messageId: "unexpected" }; } });
    assert.equal(result.failed, 1); assert.equal(sends, 0); assert.equal(updates[0]?.lastErrorCode, "INVALID_OUTBOX_PAYLOAD");
  }
});

function checkoutRow(eventType: "checkout.finalized" | "checkout.reversed" = "checkout.finalized") {
  return {
    id: "outbox-checkout", eventKey: `${eventType}:707b079c-6caf-4712-97bf-08259d741059`, eventType,
    tenantId: "tenant-1", salonId: "salon-1", recipientEmail: "admin@example.com", status: "PROCESSING", attempts: 1,
    payload: {
      version: 1, eventType, tenantId: "tenant-1", salonId: "salon-1", tenantSlug: "gentle", checkoutId: "707b079c-6caf-4712-97bf-08259d741059", reservationId: "reservation-1",
      salonName: "東京店", customerName: "山田 太郎", serviceName: "カット", staffName: "担当 花子", startsAt: "2026-10-23T04:00:00.000Z",
      occurredAt: "2026-10-23T05:00:00.000Z", subtotalYen: 5500, discountYen: 500, pointsDiscountYen: 1000, totalYen: 4000, taxYen: 364,
      payments: [{ method: "CASH", amountYen: 4000 }]
    }
  };
}

test("finalized and reversed checkout snapshots use the same captured admin delivery path", async () => {
  for (const eventType of ["checkout.finalized", "checkout.reversed"] as const) {
    const { database, updates } = fakeDatabase(checkoutRow(eventType));
    const sent: TextEmail[] = [];
    const result = await processEmailOutbox(database, { now: () => now, send: async (message) => { sent.push(message); return { messageId: `ses-${eventType}` }; } });
    assert.deepEqual(result, { sent: 1, skipped: 0, retried: 0, failed: 0 }); assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "admin@example.com");
    for (const value of ["東京店", "山田 太郎", "1,000", "4,000", "707b079c-6caf-4712-97bf-08259d741059"]) assert.ok(sent[0]!.text.includes(value), value);
    assert.match(sent[0]!.text, /ポイント/);
    if (eventType === "checkout.reversed") assert.match(sent[0]!.subject, /取消/);
    assert.doesNotMatch(sent[0]!.text, /電話番号|メールアドレス|非公開メモ/);
    assert.equal(updates[0]?.status, "SENT"); assert.equal(updates[0]?.providerMessageId, `ses-${eventType}`);
  }
});

test("checkout outbox refuses cross-tenant, cross-salon or mismatched event references", async () => {
  for (const mismatch of [{ tenantId: "other-tenant" }, { salonId: "other-salon" }, { salonId: null },
    { eventKey: "checkout.finalized:other-checkout" }, { eventType: "checkout.reversed", eventKey: "checkout.reversed:707b079c-6caf-4712-97bf-08259d741059" }]) {
    const { database, updates } = fakeDatabase({ ...checkoutRow(), ...mismatch });
    let sends = 0;
    const result = await processEmailOutbox(database, { send: async () => { sends++; return { messageId: "unexpected" }; } });
    assert.equal(result.failed, 1); assert.equal(sends, 0); assert.equal(updates[0]?.lastErrorCode, "INVALID_OUTBOX_SCOPE");
  }
});


test("checkout worker rejects inconsistent financial totals and extra private payload fields", async () => {
  for (const change of [{ totalYen: 4001 }, { pointsDiscountYen: -1 }, { taxYen: 4001 },
    { payments: [{ method: "CASH", amountYen: 3999 }] }, { memo: "private text" }, { phone: "090-1234-5678" },
    { payments: [{ method: "CASH", amountYen: 4000, reference: "private receipt reference" }] }]) {
    const row = checkoutRow();
    const { database, updates } = fakeDatabase({ ...row, payload: { ...row.payload, ...change } });
    let sends = 0;
    const result = await processEmailOutbox(database, { send: async () => { sends++; return { messageId: "unexpected" }; } });
    assert.equal(result.failed, 1); assert.equal(sends, 0); assert.equal(updates[0]?.lastErrorCode, "INVALID_OUTBOX_PAYLOAD");
  }
});
