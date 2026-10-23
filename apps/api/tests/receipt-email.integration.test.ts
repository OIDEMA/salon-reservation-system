import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
if (testDatabaseUrl) {
  const target = new URL(testDatabaseUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"),
    "Receipt email integration tests require an explicit local database whose name ends in _test.");
}

type Headers = { authorization: string; "x-tenant-slug": string; "x-salon-id": string };
type HistoryItem = { id: string; recipientEmail: string; recipientName: string; description: string; status: string;
  createdAt: string; sentAt: string | null; lastErrorCode: string | null };
type History = { defaultRecipientEmail: string; defaultRecipientName: string; defaultDescription: string; history: HistoryItem[] };

// Only identity and the external SES transport are replaced. Routes, permissions,
// tenant/salon isolation, transactions, row locks and persistence use PostgreSQL.
test("receipt email API safely queues immutable receipts in real PostgreSQL", { skip: !testDatabaseUrl }, async (t) => {
  process.env.DATABASE_URL = testDatabaseUrl!;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }, { SESv2Client }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js"), import("@aws-sdk/client-sesv2")
  ]);
  server.log.level = "silent";
  const prefix = `receipt-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const identities = new Map<string, { uid: string; name: string; email: string; email_verified: boolean }>();
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    const identity = identities.get(credential); assert.ok(identity, "Unknown receipt fixture identity"); return identity;
  });
  // A route must only enqueue; even an accidental SES call cannot reach a provider.
  const mail = t.mock.method(SESv2Client.prototype, "send", async () => { throw new Error("Receipt routes must not send mail directly"); });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "領収書結合テスト" } }); tenantIds.push(tenant.id);
    const foreignTenant = await prisma.tenant.create({ data: { slug: `${prefix}-foreign`, name: "別テナント" } }); tenantIds.push(foreignTenant.id);
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "現在の店舗名", timezone: "Asia/Tokyo" } });
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "別店舗" } });
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "他テナント店舗" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    async function account(name: string, role: "OWNER" | "STAFF" | "VIEWER", permissions?: string[], salonIds: string[] = [], foreign = false) {
      const uid = `${prefix}-${name}`;
      const selectedTenant = foreign ? foreignTenant : tenant;
      const selectedSalon = foreign ? foreignSalon : salon;
      identities.set(uid, { uid, name, email: `${uid}@example.test`, email_verified: true });
      const user = await prisma.appUser.create({ data: { firebaseUid: uid, email: `${uid}@example.test`, displayName: name } }); userIds.push(user.id);
      await prisma.tenantMembership.create({ data: { tenantId: selectedTenant.id, userId: user.id, role, salonIds,
        useCustomPermissions: permissions !== undefined, permissions: permissions ?? [] } });
      return { id: user.id, headers: (salonId = selectedSalon.id): Headers => ({ authorization: `Bearer ${uid}`,
        "x-tenant-slug": selectedTenant.slug, "x-salon-id": salonId }) };
    }
    const owner = await account("owner", "OWNER");
    const writer = await account("cash-writer", "STAFF", ["checkout.read", "checkout.write"], [salon.id]);
    const reader = await account("cash-reader", "STAFF", ["checkout.read"], [salon.id]);
    const viewer = await account("viewer", "VIEWER");
    const foreignOwner = await account("foreign-owner", "OWNER", undefined, [], true);
    const customer = await prisma.customer.create({ data: { ...scope, name: "現在の顧客名", kana: "コキャク", memo: "PRIVATE-CUSTOMER-MEMO" } });
    const service = await prisma.service.create({ data: { ...scope, name: "現在のメニュー名", category: "テスト", price: 9999, durationMinutes: 60, color: "#111111" } });
    const startsAt = new Date("2026-10-22T02:00:00.000Z");
    async function checkout(status: "FINALIZED" | "DRAFT" | "REVERSED" = "FINALIZED") {
      const reservation = await prisma.reservation.create({ data: { ...scope, customerId: customer.id, serviceId: service.id,
        startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), status: "COMPLETED", paymentStatus: "PAID" } });
      return prisma.cashCheckout.create({ data: { ...scope, reservationId: reservation.id, status, version: 3,
        legacyPaymentStatus: "UNPAID", finalizedAt: status === "DRAFT" ? null : new Date("2026-10-22T03:00:00.000Z"),
        finalizedByUserId: status === "DRAFT" ? null : owner.id, createdByUserId: owner.id, createRequestId: randomUUID(),
        notes: "PRIVATE-CHECKOUT-NOTES", reservationSnapshot: { customerName: "確定時のお客様", salonName: "確定時の店舗名",
          serviceName: "確定時のメニュー名", startsAt: startsAt.toISOString(), timezone: "Asia/Tokyo",
          customerId: customer.id, staffName: "PRIVATE-STAFF-NAME", memo: "PRIVATE-RESERVATION-MEMO" },
        subtotalYen: 2300, discountYen: 100, taxYen: 178, totalYen: 2200, cashYen: 1000,
        taxBreakdown: [{ taxRate: 10, taxableTotalYen: 1000, taxYen: 90 }, { taxRate: 8, taxableTotalYen: 1200, taxYen: 88 }],
        items: { create: [{ lineNumber: 1, label: "確定した施術", quantity: 1, unitPriceYen: 1100, discountYen: 100, taxRate: 10, taxYen: 90, totalYen: 1000 },
          { lineNumber: 2, label: "確定した店販", quantity: 2, unitPriceYen: 600, discountYen: 0, taxRate: 8, taxYen: 88, totalYen: 1200 }] },
        payments: { create: [{ method: "CASH", amountYen: 1000, reference: "PRIVATE-CASH-REFERENCE" },
          { method: "CARD", amountYen: 1200, reference: "PRIVATE-CARD-REFERENCE" }] }
      } });
    }
    const finalized = await checkout();
    const draft = await checkout("DRAFT");
    const reversed = await checkout("REVERSED");
    const base = (id = finalized.id) => `/api/cash/checkouts/${id}/receipt-emails`;
    const input = { version: finalized.version, recipientEmail: "receipt@example.test", recipientName: "領収 太郎", description: "施術代として" };
    async function call(method: "GET" | "POST", url: string, payload?: unknown, headers = owner.headers()) {
      return server.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
    }
    async function good<T>(method: "GET" | "POST", url: string, payload?: unknown, headers = owner.headers(), status = 200): Promise<T> {
      const response = await call(method, url, payload, headers);
      assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
      assert.equal(response.headers["cache-control"], "private, no-store");
      return response.json() as T;
    }
    const queued = (extra: Record<string, unknown> = {}) => ({ ...input, requestId: randomUUID(), ...extra });

    await t.test("identity, cash permissions and tenant/salon scope protect all endpoints", async () => {
      assert.equal((await server.inject({ url: base() })).statusCode, 401);
      const initial = await good<History>("GET", base(), undefined, reader.headers());
      assert.equal(initial.defaultRecipientEmail, ""); assert.equal(initial.defaultRecipientName, "確定時のお客様");
      assert.equal(initial.defaultDescription, "施術代として"); assert.deepEqual(initial.history, []);
      assert.equal((await call("POST", `${base()}/preview`, input, reader.headers())).statusCode, 403);
      assert.equal((await call("POST", base(), queued(), reader.headers())).statusCode, 403);
      assert.equal((await call("POST", `${base()}/preview`, input, viewer.headers())).statusCode, 403);
      assert.equal((await call("POST", base(), queued(), viewer.headers())).statusCode, 403);
      await good("POST", `${base()}/preview`, input, writer.headers());
      for (const [method, suffix, payload] of [["GET", "", undefined], ["POST", "/preview", input], ["POST", "", queued()]] as const) {
        assert.equal((await call(method, `${base()}${suffix}`, payload, owner.headers(otherSalon.id))).statusCode, 404);
        assert.equal((await call(method, `${base()}${suffix}`, payload, foreignOwner.headers())).statusCode, 404);
        assert.equal((await call(method, `${base()}${suffix}`, payload, writer.headers(otherSalon.id))).statusCode, 403);
      }
      assert.equal((await call("GET", base(randomUUID()))).statusCode, 404);
      assert.equal(await prisma.emailOutbox.count({ where: scope }), 0);
    });

    await t.test("preview uses settled amounts and excludes every internal note and payment reference", async () => {
      const preview = await good<{ subject: string; text: string }>("POST", `${base()}/preview`, input);
      assert.match(preview.subject, /領収書/); assert.match(preview.subject, /確定時の店舗名/);
      for (const expected of [input.recipientName, input.description, "確定した施術", "確定した店販", "2,200", "178", "カード", "現金", finalized.id]) {
        assert.ok(preview.text.includes(expected), `Preview must include ${expected}`);
      }
      assert.doesNotMatch(JSON.stringify(preview), /PRIVATE-|現在の店舗名|現在の顧客名|現在のメニュー名|9999/);
      assert.equal(await prisma.emailOutbox.count({ where: scope }), 0);
      assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, action: "checkout.receipt.queue" } }), 0);
      assert.equal(mail.mock.callCount(), 0);
    });

    await t.test("invalid input, stale versions and unfinalized/reversed checkouts cannot queue mail", async () => {
      for (const change of [{ recipientEmail: "invalid" }, { recipientEmail: "receipt@example.test\r\nBcc: other@example.test" },
        { recipientName: "" }, { recipientName: "宛名\n別行" }, { description: "" }, { description: "説明\u0000" },
        { version: 0 }, { version: 1.5 }]) {
        assert.equal((await call("POST", `${base()}/preview`, { ...input, ...change })).statusCode, 400);
        assert.equal((await call("POST", base(), queued(change))).statusCode, 400);
      }
      assert.equal((await call("POST", base(), { ...input })).statusCode, 400);
      assert.equal((await call("POST", base(), queued({ requestId: "not-a-uuid" }))).statusCode, 400);
      assert.equal((await call("POST", `${base()}/preview`, { ...input, version: finalized.version - 1 })).statusCode, 409);
      assert.equal((await call("POST", base(), queued({ version: finalized.version - 1 }))).statusCode, 409);
      for (const closed of [draft, reversed]) {
        assert.equal((await call("POST", `${base(closed.id)}/preview`, { ...input, version: closed.version })).statusCode, 409);
        assert.equal((await call("POST", base(closed.id), queued({ version: closed.version }))).statusCode, 409);
      }
      assert.equal(await prisma.emailOutbox.count({ where: scope }), 0);
    });

    let sentInput: ReturnType<typeof queued>;
    let sentItem: HistoryItem;
    await t.test("concurrent retries commit one outbox snapshot and one audit event", async () => {
      sentInput = queued();
      const responses = await Promise.all([call("POST", base(), sentInput, writer.headers()), call("POST", base(), sentInput, writer.headers())]);
      assert.deepEqual(responses.map((response) => response.statusCode), [202, 202], responses.map((response) => response.body).join("\n"));
      assert.deepEqual(responses[0].json(), responses[1].json());
      sentItem = responses[0].json();
      assert.equal(sentItem.status, "PENDING"); assert.equal(sentItem.recipientEmail, input.recipientEmail);
      assert.equal(sentItem.recipientName, input.recipientName); assert.equal(sentItem.sentAt, null); assert.equal(sentItem.lastErrorCode, null);
      const eventKey = `checkout.receipt:${finalized.id}:${sentInput.requestId}`;
      assert.equal(await prisma.emailOutbox.count({ where: { ...scope, eventKey } }), 1);
      const outbox = await prisma.emailOutbox.findUniqueOrThrow({ where: { eventKey } });
      assert.equal(outbox.eventType, "checkout.receipt"); assert.equal(outbox.attempts, 0); assert.equal(outbox.sentAt, null);
      const payload = outbox.payload as { checkoutId: string; requestId: string; requestHash: string; receipt: Record<string, unknown> };
      assert.equal(payload.checkoutId, finalized.id); assert.equal(payload.requestId, sentInput.requestId); assert.match(payload.requestHash, /^[a-f0-9]{64}$/);
      assert.equal(payload.receipt.totalYen, 2200); assert.equal(payload.receipt.issuerName, "確定時の店舗名");
      assert.doesNotMatch(JSON.stringify(payload.receipt), /PRIVATE-|customerId|staffName|reference|notes|memo/);
      const audits = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, resourceId: finalized.id, action: "checkout.receipt.queue" } });
      assert.equal(audits.length, 1); assert.equal(audits[0].actorUserId, writer.id);
      assert.deepEqual(audits[0].metadata, { outboxId: outbox.id, receiptNumber: finalized.id, salonId: salon.id });
      assert.equal(mail.mock.callCount(), 0);
    });

    await t.test("request IDs reject changed content while a queued snapshot remains immutable", async () => {
      for (const change of [{ recipientEmail: "different@example.test" }, { recipientName: "別の宛名" }, { description: "別の但し書き" }, { version: 99 }]) {
        assert.equal((await call("POST", base(), { ...sentInput, ...change })).statusCode, 409);
      }
      const before = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: sentItem.id } });
      await prisma.salon.update({ where: { id: salon.id }, data: { name: "送付後に変更した店舗" } });
      await prisma.customer.update({ where: { id: customer.id }, data: { name: "送付後に変更した顧客" } });
      await prisma.service.update({ where: { id: service.id }, data: { name: "送付後のメニュー", price: 50000 } });
      const replay = await good<HistoryItem>("POST", base(), sentInput, owner.headers(), 202);
      assert.deepEqual(replay, sentItem);
      assert.deepEqual((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: sentItem.id } })).payload, before.payload);
      const history = await good<History>("GET", base());
      assert.equal(history.defaultRecipientEmail, input.recipientEmail);
      assert.equal(history.defaultRecipientName, "確定時のお客様");
      assert.deepEqual(history.history, [sentItem]);
      assert.doesNotMatch(JSON.stringify(history), /PRIVATE-|requestHash|providerMessageId|payload/);
    });

    await t.test("an audit failure rolls back its outbox insertion", async () => {
      const body = queued({ recipientEmail: "rollback@example.test" });
      const originalTransaction = prisma.$transaction;
      const executeTransaction = originalTransaction.bind(prisma);
      // Prisma exposes dynamic methods through proxy descriptors whose value is
      // undefined, so node:test mock.method cannot replace these methods.
      prisma.$transaction = ((operation: (tx: any) => Promise<unknown>, options: unknown) =>
        executeTransaction(async (tx) => operation(new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "auditLog") return new Proxy(target.auditLog, {
              get(audit, action, auditReceiver) {
                if (action === "create") return async () => { throw new Error("Synthetic receipt audit failure"); };
                return Reflect.get(audit, action, auditReceiver);
              }
            });
            return Reflect.get(target, property, receiver);
          }
        })), options as any)) as typeof prisma.$transaction;
      try {
        const response = await call("POST", base(), body);
        assert.equal(response.statusCode, 500, response.body);
      } finally { prisma.$transaction = originalTransaction; }
      assert.equal(await prisma.emailOutbox.count({ where: { ...scope, eventKey: `checkout.receipt:${finalized.id}:${body.requestId}` } }), 0);
      assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, resourceId: finalized.id, action: "checkout.receipt.queue" } }), 1);
    });

    await t.test("history returns the latest 50 scoped entries and current delivery status", async () => {
      const original = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: sentItem.id } });
      const snapshot = original.payload as Record<string, any>;
      const recent = new Date(Date.now() + 60_000);
      const entries = Array.from({ length: 52 }, (_, index) => {
        const requestId = randomUUID();
        return { ...scope, eventType: "checkout.receipt", eventKey: `checkout.receipt:${finalized.id}:${requestId}`,
          recipientEmail: `history-${index}@example.test`, payload: { ...snapshot, requestId },
          status: index === 51 ? "SENT" : index === 50 ? "FAILED" : "PENDING",
          sentAt: index === 51 ? recent : null, lastErrorCode: index === 50 ? "MESSAGE_REJECTED" : null,
          createdAt: new Date(recent.getTime() + index * 1000) };
      });
      await prisma.emailOutbox.createMany({ data: entries });
      // These matching event keys cannot leak across salon or tenant boundaries.
      for (const foreign of [{ tenantId: tenant.id, salonId: otherSalon.id }, { tenantId: foreignTenant.id, salonId: foreignSalon.id }]) {
        await prisma.emailOutbox.create({ data: { ...foreign, eventType: "checkout.receipt", eventKey: `checkout.receipt:${finalized.id}:${randomUUID()}`,
          recipientEmail: "PRIVATE-FOREIGN@example.test", payload: snapshot, createdAt: new Date(recent.getTime() + 100_000) } });
      }
      const history = await good<History>("GET", base(), undefined, reader.headers());
      assert.equal(history.history.length, 50); assert.equal(history.defaultRecipientEmail, "history-51@example.test");
      assert.deepEqual(history.history.map((item) => item.recipientEmail), Array.from({ length: 50 }, (_, index) => `history-${51 - index}@example.test`));
      assert.equal(history.history[0].status, "SENT"); assert.equal(history.history[0].sentAt, recent.toISOString());
      assert.equal(history.history[1].status, "FAILED"); assert.equal(history.history[1].lastErrorCode, "MESSAGE_REJECTED");
      assert.doesNotMatch(JSON.stringify(history), /PRIVATE-|requestHash|providerMessageId|payload/);
      assert.equal(mail.mock.callCount(), 0);
    });
  } finally {
    await server.close(); auth.mock.restore(); mail.mock.restore();
    // Remove only this run's generated fixture data, preserving other test runs.
    if (tenantIds.length) {
      const where = { tenantId: { in: tenantIds } };
      await prisma.emailOutbox.deleteMany({ where });
      await prisma.cashCheckoutItem.deleteMany({ where });
      await prisma.cashPaymentAllocation.deleteMany({ where });
      await prisma.cashCheckout.deleteMany({ where });
      await prisma.reservation.deleteMany({ where });
      await prisma.customer.deleteMany({ where });
      await prisma.service.deleteMany({ where });
      await prisma.salon.deleteMany({ where });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
