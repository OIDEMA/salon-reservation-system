import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { businessDateAt } from "../src/cash-domain.js";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
if (testDatabaseUrl) {
  const target = new URL(testDatabaseUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"),
    "Cash integration tests require an explicit local database whose name ends in _test.");
}

type Headers = { authorization: string; "x-tenant-slug": string; "x-salon-id": string };
type Payment = { method: "CASH" | "CARD" | "BANK" | "EXTERNAL_PREPAYMENT" | "OTHER"; amountYen: number; reference: string };
type Receipt = { id: string; reservationId: string; version: number; status: string; totalYen: number; taxYen: number; cashYen: number; pointsDiscountYen: number;
  supersedesCheckoutId: string | null; finalizedSessionId: string | null; reversedSessionId: string | null;
  reservationSnapshot: Record<string, unknown>; legacyPaidAcknowledged: boolean; notes: string;
  items: { label: string; quantity: number; unitPriceYen: number; discountYen: number; pointsDiscountYen: number; taxRate: number; taxYen: number; totalYen: number }[];
  payments: Payment[]; taxBreakdown: { taxRate: number; taxYen: number; taxableTotalYen: number }[] };
type Register = { id: string; version: number; status: string; businessDate: string; expectedCashYen: number; differenceYen: number | null;
  movements: { kind: string; amountYen: number }[]; closeSnapshot: any };

// Import the actual app only after selecting the disposable database. Authentication
// alone is mocked; tenant/salon guards, permissions, routes and transactions are real.
test("cash and register API preserve accounting with real PostgreSQL", { skip: !testDatabaseUrl }, async (t) => {
  process.env.DATABASE_URL = testDatabaseUrl!;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")
  ]);
  server.log.level = "silent";
  const databaseErrors: { code?: string; databaseCode?: unknown }[] = [];
  server.addHook("onError", async (_request, _reply, error) => {
    if (error.name === "PrismaClientKnownRequestError") {
      const problem = error as Error & { code?: string; meta?: { code?: unknown } };
      databaseErrors.push({ code: problem.code, databaseCode: problem.meta?.code });
    }
  });
  const prefix = `cash-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const identities = new Map<string, { uid: string; name: string; email: string; email_verified: boolean }>();
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    const identity = identities.get(credential); assert.ok(identity, "Unknown cash fixture identity"); return identity;
  });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "会計結合テスト" } }); tenantIds.push(tenant.id);
    const foreignTenant = await prisma.tenant.create({ data: { slug: `${prefix}-foreign`, name: "別テナント検証" } }); tenantIds.push(foreignTenant.id);
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "別テナント店舗" } });
    async function fixture(name: string, price = 1000, paymentStatus: "UNPAID" | "PAID" = "UNPAID") {
      const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: `${prefix}-${name}`, timezone: "Asia/Tokyo" } });
      const scope = { tenantId: tenant.id, salonId: salon.id };
      const customer = await prisma.customer.create({ data: { ...scope, name: `検証顧客-${name}`, kana: "ケンショウ" } });
      const service = await prisma.service.create({ data: { ...scope, name: `検証施術-${name}`, category: "テスト", price, durationMinutes: 60, color: "#111111" } });
      const startsAt = new Date(`${businessDateAt(new Date(), "Asia/Tokyo")}T11:00:00+09:00`);
      const reservation = await prisma.reservation.create({ data: { ...scope, customerId: customer.id, serviceId: service.id,
        startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), status: "COMPLETED", paymentStatus } });
      return { ...scope, salon, customer, service, reservation };
    }
    const a = await fixture("lifecycle", 1100);
    const b = await fixture("prepaid", 9800, "PAID");
    const c = await fixture("changed", 1000);
    const d = await fixture("race", 1000);
    const e = await fixture("close-race", 1000);
    const f = await fixture("past-refund", 2000);
    const g = await fixture("revocation", 1000);
    async function account(name: string, role: "OWNER" | "STAFF" | "VIEWER", permissions?: string[], salonIds: string[] = []) {
      const uid = `${prefix}-${name}`;
      identities.set(uid, { uid, name, email: `${uid}@example.test`, email_verified: true });
      const user = await prisma.appUser.create({ data: { firebaseUid: uid, email: `${uid}@example.test`, displayName: name } }); userIds.push(user.id);
      await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role, salonIds,
        useCustomPermissions: permissions !== undefined, permissions: permissions ?? [] } });
      return { id: user.id, headers: (salonId = a.salonId): Headers => ({ authorization: `Bearer ${uid}`, "x-tenant-slug": tenant.slug, "x-salon-id": salonId }) };
    }
    const owner = await account("owner", "OWNER");
    const staff = await account("staff", "STAFF");
    const viewer = await account("viewer", "VIEWER");
    const restricted = await account("cash-only", "STAFF", ["checkout.read", "checkout.write"], [a.salonId]);
    async function call(method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown, headers = owner.headers()) {
      return server.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    }
    async function good<T>(method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown, headers = owner.headers(), status = 200): Promise<T> {
      const response = await call(method, url, payload, headers);
      assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`); return response.json() as T;
    }
    async function create(reservationId: string, salonId: string) {
      return good<Receipt>("POST", "/api/cash/checkouts", { reservationId, requestId: randomUUID() }, owner.headers(salonId), 201);
    }
    function body(checkout: Receipt, payments: Payment[], extras: Record<string, unknown> = {}) {
      return { version: checkout.version,
        items: checkout.items.map(({ label, quantity, unitPriceYen, discountYen, taxRate }) => ({ label, quantity, unitPriceYen, discountYen, taxRate })),
        payments: payments.map(({ method, amountYen, reference }) => ({ method, amountYen, reference })),
        pointsDiscountYen: checkout.pointsDiscountYen, notes: checkout.notes, legacyPaidAcknowledged: false, ...extras };
    }
    async function update(checkout: Receipt, payments: Payment[], salonId: string, extras: Record<string, unknown> = {}) {
      return good<Receipt>("PUT", `/api/cash/checkouts/${checkout.id}`, body(checkout, payments, extras), owner.headers(salonId));
    }
    async function open(salonId: string, openingCashYen = 5000) {
      return good<Register>("POST", "/api/cash/register-sessions", { businessDate: businessDateAt(new Date(), "Asia/Tokyo"), openingCashYen, requestId: randomUUID() }, owner.headers(salonId));
    }
    async function spent(customerId: string) { return (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).totalSpent; }
    let receipt: Receipt;
    let register: Register;

    await t.test("actual identity, role and salon guards reject writes and foreign IDs", async () => {
      assert.equal((await server.inject({ url: "/api/cash/checkouts" })).statusCode, 401);
      assert.equal((await call("POST", "/api/cash/checkouts", { reservationId: a.reservation.id, requestId: randomUUID() }, viewer.headers())).statusCode, 403);
      assert.equal((await call("POST", "/api/cash/register-sessions", {}, staff.headers())).statusCode, 403);
      assert.equal((await call("POST", `/api/cash/checkouts/${randomUUID()}/reverse`, {}, staff.headers())).statusCode, 403);
      assert.equal((await call("GET", "/api/cash/checkouts", undefined, restricted.headers())).statusCode, 200);
      assert.equal((await call("GET", "/api/cash/register-sessions", undefined, restricted.headers())).statusCode, 403);
      assert.equal((await call("GET", "/api/reservations", undefined, restricted.headers())).statusCode, 403);
      assert.equal((await call("GET", "/api/cash/checkouts", undefined, restricted.headers(b.salonId))).statusCode, 403);
      assert.equal((await call("GET", "/api/cash/checkouts", undefined, owner.headers(foreignSalon.id))).statusCode, 403);
      const denied = { ...owner.headers(), "x-tenant-slug": foreignTenant.slug, "x-salon-id": foreignSalon.id };
      assert.equal((await call("GET", "/api/cash/checkouts", undefined, denied)).statusCode, 403);
      receipt = await create(a.reservation.id, a.salonId);
      assert.equal((await call("GET", `/api/cash/checkouts/${receipt.id}`, undefined, owner.headers(b.salonId))).statusCode, 404);
      assert.equal((await call("PUT", `/api/cash/checkouts/${receipt.id}`, body(receipt, []), owner.headers(b.salonId))).statusCode, 404);
      assert.equal((await call("POST", `/api/cash/checkouts/${receipt.id}/finalize`, { version: receipt.version, requestId: randomUUID() }, owner.headers(b.salonId))).statusCode, 404);
      assert.equal((await call("POST", "/api/cash/checkouts", { reservationId: a.reservation.id, requestId: randomUUID() }, owner.headers(b.salonId))).statusCode, 404);
    });

    await t.test("drafts, exact allocation, immutable settlement and idempotent concurrent finalize", async () => {
      const sameDrafts = await Promise.all([create(a.reservation.id, a.salonId), create(a.reservation.id, a.salonId)]);
      assert.deepEqual(sameDrafts.map((entry) => entry.id), [receipt.id, receipt.id]);
      assert.equal(await prisma.cashCheckout.count({ where: { tenantId: tenant.id, salonId: a.salonId, reservationId: a.reservation.id } }), 1);
      const items = [{ label: "施術", quantity: 1, unitPriceYen: 1100, discountYen: 100, taxRate: 10 },
        { label: "店販", quantity: 2, unitPriceYen: 600, discountYen: 0, taxRate: 8 }];
      const oldVersion = receipt.version;
      receipt = await update(receipt, [{ method: "CASH", amountYen: 1000, reference: "" }], a.salonId, { items, notes: "会計検証" });
      assert.equal(receipt.totalYen, 2200); assert.equal(receipt.taxYen, 178);
      assert.equal(receipt.items.reduce((sum, item) => sum + item.taxYen, 0), receipt.taxYen);
      assert.equal((await call("PUT", `/api/cash/checkouts/${receipt.id}`, { ...body(receipt, []), version: oldVersion })).statusCode, 409);
      assert.equal((await call("POST", `/api/cash/checkouts/${receipt.id}/finalize`, { version: receipt.version, requestId: randomUUID() })).statusCode, 400);
      register = await open(a.salonId);
      receipt = await update(receipt, [{ method: "CASH", amountYen: 1000, reference: "" }, { method: "CARD", amountYen: 1200, reference: "端末確認済み" }], a.salonId);
      assert.equal((await call("POST", `/api/cash/checkouts/${receipt.id}/finalize`, { version: receipt.version, requestId: randomUUID() })).statusCode, 409);
      const input = { version: receipt.version, requestId: randomUUID(), registerSessionId: register.id };
      const finalized = await Promise.all([call("POST", `/api/cash/checkouts/${receipt.id}/finalize`, input), call("POST", `/api/cash/checkouts/${receipt.id}/finalize`, input)]);
      assert.deepEqual(finalized.map((response) => response.statusCode), [200, 200], JSON.stringify({ statuses: finalized.map((response) => response.statusCode), databaseErrors }));
      receipt = finalized[0].json(); assert.equal(receipt.status, "FINALIZED"); assert.equal(receipt.finalizedSessionId, register.id);
      assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, resourceId: receipt.id, action: "checkout.finalize" } }), 1);
      assert.equal(await prisma.cashRegisterMovement.count({ where: { tenantId: tenant.id, checkoutId: receipt.id, kind: "SALE" } }), 1);
      assert.equal(await spent(a.customer.id), 2200);
      assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: a.reservation.id } })).paymentStatus, "PAID");
      assert.equal((await call("POST", `/api/cash/checkouts/${receipt.id}/finalize`, { ...input, requestId: randomUUID() })).statusCode, 409);
      assert.equal((await call("POST", `/api/cash/checkouts/${receipt.id}/finalize`, { ...input, version: input.version + 1 })).statusCode, 409);
      assert.equal((await call("PUT", `/api/cash/checkouts/${receipt.id}`, body(receipt, []))).statusCode, 409);
      assert.equal((await call("POST", `/api/cash/checkouts/${receipt.id}/refresh-reservation`, { version: receipt.version })).statusCode, 409);
      assert.equal((await call("PATCH", `/api/reservations/${a.reservation.id}`, { durationMinutes: 90 })).statusCode, 409);
      assert.equal((await call("PATCH", `/api/reservations/${a.reservation.id}`, { paymentStatus: "UNPAID" })).statusCode, 409);
      await prisma.service.update({ where: { id: a.service.id }, data: { price: 1400, name: "改定後施術" } });
      const unchanged = await good<Receipt>("GET", `/api/cash/checkouts/${receipt.id}`);
      assert.equal(unchanged.totalYen, 2200); assert.equal(unchanged.items[0].unitPriceYen, 1100);
      const customer = await good<{ totalSpent: number }>("GET", `/api/admin/customers/${a.customer.id}`);
      assert.equal(customer.totalSpent, 2200);
    });

    await t.test("full reversal is authorized and idempotent; a corrected receipt can replace it", async () => {
      const input = { requestId: randomUUID(), reason: "金額を訂正するため", refundRecorded: true, registerSessionId: register.id };
      assert.equal((await call("POST", `/api/cash/checkouts/${receipt.id}/reverse`, input, staff.headers())).statusCode, 403);
      const responses = await Promise.all([call("POST", `/api/cash/checkouts/${receipt.id}/reverse`, input), call("POST", `/api/cash/checkouts/${receipt.id}/reverse`, input)]);
      assert.deepEqual(responses.map((response) => response.statusCode), [200, 200], responses.map((response) => response.body).join("\n"));
      const reversed: Receipt = responses[0].json(); assert.equal(reversed.status, "REVERSED"); assert.equal(reversed.totalYen, 2200);
      assert.equal(reversed.reversedSessionId, register.id); assert.equal(await spent(a.customer.id), 0);
      assert.equal(await prisma.cashRegisterMovement.count({ where: { tenantId: tenant.id, checkoutId: receipt.id, kind: "REFUND" } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, resourceId: receipt.id, action: "checkout.reverse" } }), 1);
      assert.equal((await call("POST", `/api/cash/checkouts/${receipt.id}/reverse`, { ...input, reason: "別理由" })).statusCode, 409);
      assert.equal((await call("POST", `/api/cash/checkouts/${receipt.id}/reverse`, { ...input, requestId: randomUUID() })).statusCode, 409);
      const correction = await create(a.reservation.id, a.salonId);
      assert.notEqual(correction.id, receipt.id); assert.equal(correction.supersedesCheckoutId, receipt.id); assert.equal(correction.totalYen, 1400);
      const prepared = await update(correction, [{ method: "CASH", amountYen: 400, reference: "" }, { method: "CARD", amountYen: 1000, reference: "訂正会計確認" }], a.salonId);
      receipt = await good<Receipt>("POST", `/api/cash/checkouts/${prepared.id}/finalize`, { version: prepared.version, requestId: randomUUID(), registerSessionId: register.id });
      assert.equal(receipt.status, "FINALIZED"); assert.equal(await spent(a.customer.id), 1400);
      assert.equal(await prisma.cashCheckout.count({ where: { tenantId: tenant.id, reservationId: a.reservation.id, status: "FINALIZED" } }), 1);
    });

    await t.test("legacy PAID cannot be collected twice and requires deliberate external prepayment recording", async () => {
      let prepaid = await create(b.reservation.id, b.salonId);
      const headers = owner.headers(b.salonId);
      prepaid = await update(prepaid, [{ method: "CASH", amountYen: 9800, reference: "" }], b.salonId, { legacyPaidAcknowledged: true });
      const session = await open(b.salonId, 500);
      const finalize = () => call("POST", `/api/cash/checkouts/${prepaid.id}/finalize`, { version: prepaid.version, requestId: randomUUID(), registerSessionId: session.id }, headers);
      assert.equal((await finalize()).statusCode, 409);
      prepaid = await update(prepaid, [{ method: "EXTERNAL_PREPAYMENT", amountYen: 9800, reference: "" }], b.salonId);
      assert.equal((await finalize()).statusCode, 400);
      prepaid = await update(prepaid, [{ method: "EXTERNAL_PREPAYMENT", amountYen: 9800, reference: "" }], b.salonId, { legacyPaidAcknowledged: true });
      assert.equal((await finalize()).statusCode, 400);
      prepaid = await update(prepaid, [{ method: "EXTERNAL_PREPAYMENT", amountYen: 9800, reference: "既存入金台帳をスタッフ確認" }], b.salonId, { legacyPaidAcknowledged: true });
      assert.equal((await call("POST", `/api/cash/checkouts/${prepaid.id}/finalize`, { version: prepaid.version, requestId: randomUUID() }, headers)).statusCode, 409);
      const settled = await finalize(); assert.equal(settled.statusCode, 200, settled.body);
      assert.equal(settled.json().cashYen, 0); assert.equal(settled.json().finalizedSessionId, session.id); assert.equal(await spent(b.customer.id), 9800);
      const changedSession = await good<Register>("GET", `/api/cash/register-sessions/${session.id}`, undefined, headers);
      assert.equal(changedSession.expectedCashYen, 500); assert.equal(changedSession.version, session.version + 1); assert.equal(changedSession.movements.length, 0);
      const closed = await good<Register>("POST", `/api/cash/register-sessions/${session.id}/close`, { version: changedSession.version, requestId: randomUUID(), countedCashYen: 500 }, headers);
      assert.equal(closed.closeSnapshot.salesTotalYen, 9800); assert.equal(closed.closeSnapshot.paymentTotals.find((row: any) => row.method === "EXTERNAL_PREPAYMENT").salesYen, 9800);
    });

    await t.test("changed reservation blocks stale finalization and explicit refresh rebuilds the draft", async () => {
      const headers = owner.headers(c.salonId);
      let changed = await create(c.reservation.id, c.salonId);
      changed = await update(changed, [{ method: "CARD", amountYen: 900, reference: "仮記録" }], c.salonId, { pointsDiscountYen: 100 });
      const session = await open(c.salonId, 500);
      await good("PATCH", `/api/reservations/${c.reservation.id}`, { durationMinutes: 75 }, headers);
      const stale = await call("POST", `/api/cash/checkouts/${changed.id}/finalize`, { version: changed.version, requestId: randomUUID(), registerSessionId: session.id }, headers);
      assert.equal(stale.statusCode, 409, stale.body); assert.match(stale.json().message, /予約の内容.*変更/);
      assert.equal(await spent(c.customer.id), 0);
      changed = await good<Receipt>("POST", `/api/cash/checkouts/${changed.id}/refresh-reservation`, { version: changed.version }, headers);
      assert.equal(changed.payments.length, 0); assert.equal(changed.cashYen, 0); assert.equal(changed.legacyPaidAcknowledged, false);
      assert.equal(changed.pointsDiscountYen, 0); assert.ok(changed.items.every((item) => item.pointsDiscountYen === 0));
      const storedReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: c.reservation.id } });
      assert.equal(changed.reservationSnapshot.endsAt, storedReservation.endsAt.toISOString());
      changed = await update(changed, [{ method: "CARD", amountYen: 1000, reference: "改定予約を確認" }], c.salonId);
      assert.equal((await call("POST", `/api/cash/checkouts/${changed.id}/finalize`, { version: changed.version, requestId: randomUUID() }, headers)).statusCode, 409);
      await good("POST", `/api/cash/checkouts/${changed.id}/finalize`, { version: changed.version, requestId: randomUUID(), registerSessionId: session.id }, headers);
      assert.equal(await spent(c.customer.id), 1000);
      assert.equal((await call("PATCH", `/api/reservations/${c.reservation.id}`, { durationMinutes: 80 }, headers)).statusCode, 409);
      assert.equal((await good<Register>("GET", `/api/cash/register-sessions/${session.id}`, undefined, headers)).version, 2);
    });

    await t.test("close freezes all payment allocations, cash difference and prohibits every late write", async () => {
      register = await good<Register>("GET", `/api/cash/register-sessions/${register.id}`);
      assert.equal(register.expectedCashYen, 5400);
      const movement = { version: register.version, requestId: randomUUID(), kind: "IN", amountYen: 300, reason: "釣銭補充" };
      register = await good<Register>("POST", `/api/cash/register-sessions/${register.id}/movements`, movement);
      const replay = await good<Register>("POST", `/api/cash/register-sessions/${register.id}/movements`, movement);
      assert.equal(replay.version, register.version); assert.equal(replay.expectedCashYen, 5700);
      register = await good<Register>("POST", `/api/cash/register-sessions/${register.id}/movements`, { version: register.version, requestId: randomUUID(), kind: "OUT", amountYen: 100, reason: "備品購入" });
      assert.equal(register.expectedCashYen, 5600);
      const close = { version: register.version, requestId: randomUUID(), countedCashYen: 5550, note: "50円差額を確認" };
      const closed = await good<Register>("POST", `/api/cash/register-sessions/${register.id}/close`, close);
      assert.equal(closed.status, "CLOSED"); assert.equal(closed.differenceYen, -50); assert.equal(closed.expectedCashYen, 5600);
      const snapshot = closed.closeSnapshot;
      assert.equal(snapshot.salesCount, 2); assert.equal(snapshot.refundsCount, 1);
      assert.equal(snapshot.salesTotalYen, 3600); assert.equal(snapshot.refundsTotalYen, 2200); assert.equal(snapshot.netTotalYen, 1400);
      assert.equal(snapshot.discountYen, 100); assert.equal(snapshot.taxYen, 305); assert.equal(snapshot.refundsTaxYen, 178);
      assert.deepEqual(snapshot.paymentTotals.find((row: any) => row.method === "CASH"), { method: "CASH", salesYen: 1400, refundsYen: 1000, netYen: 400 });
      assert.deepEqual(snapshot.paymentTotals.find((row: any) => row.method === "CARD"), { method: "CARD", salesYen: 2200, refundsYen: 1200, netYen: 1000 });
      assert.deepEqual((await good<Register>("POST", `/api/cash/register-sessions/${register.id}/close`, close)).closeSnapshot, snapshot);
      assert.equal((await call("POST", `/api/cash/register-sessions/${register.id}/close`, { ...close, countedCashYen: 5551 })).statusCode, 409);
      assert.equal((await call("POST", `/api/cash/register-sessions/${register.id}/movements`, { version: closed.version, requestId: randomUUID(), kind: "IN", amountYen: 100, reason: "締め後" })).statusCode, 409);
      assert.equal((await call("POST", `/api/cash/checkouts/${receipt.id}/reverse`, { requestId: randomUUID(), reason: "締め後の返金", refundRecorded: true, registerSessionId: register.id })).statusCode, 409);
      const lateReservation = await prisma.reservation.create({ data: { tenantId: tenant.id, salonId: a.salonId, customerId: a.customer.id, serviceId: a.service.id,
        startsAt: new Date(a.reservation.startsAt.getTime() + 7_200_000), endsAt: new Date(a.reservation.endsAt.getTime() + 7_200_000), status: "COMPLETED" } });
      let late = await create(lateReservation.id, a.salonId);
      late = await update(late, [{ method: "CARD", amountYen: 1400, reference: "締め後カード" }], a.salonId);
      const rejected = await call("POST", `/api/cash/checkouts/${late.id}/finalize`, { version: late.version, requestId: randomUUID(), registerSessionId: register.id });
      assert.equal(rejected.statusCode, 409, rejected.body); assert.match(rejected.json().message, /締め済み/);
      assert.equal(await spent(a.customer.id), 1400);
      assert.deepEqual((await good<Register>("GET", `/api/cash/register-sessions/${register.id}`)).closeSnapshot, snapshot);
      assert.equal((await call("GET", `/api/cash/register-sessions/${register.id}`, undefined, owner.headers(b.salonId))).statusCode, 404);
    });

    await t.test("card finalization and concurrent close serialize without omitted sales", async () => {
      const headers = owner.headers(d.salonId);
      let card = await create(d.reservation.id, d.salonId);
      card = await update(card, [{ method: "CARD", amountYen: 1000, reference: "競合テスト" }], d.salonId);
      let session = await open(d.salonId, 100);
      const responses = await Promise.all([
        call("POST", `/api/cash/checkouts/${card.id}/finalize`, { version: card.version, requestId: randomUUID(), registerSessionId: session.id }, headers),
        call("POST", `/api/cash/register-sessions/${session.id}/close`, { version: session.version, requestId: randomUUID(), countedCashYen: 100 }, headers)
      ]);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409], responses.map((response) => response.body).join("\n"));
      session = await good<Register>("GET", `/api/cash/register-sessions/${session.id}`, undefined, headers);
      if (session.status === "OPEN") session = await good<Register>("POST", `/api/cash/register-sessions/${session.id}/close`, { version: session.version, requestId: randomUUID(), countedCashYen: 100 }, headers);
      const finalized = await prisma.cashCheckout.count({ where: { tenantId: tenant.id, salonId: d.salonId, status: "FINALIZED" } });
      assert.equal(session.closeSnapshot.salesCount, finalized); assert.equal(session.closeSnapshot.salesTotalYen, finalized * 1000);
      assert.equal(session.closeSnapshot.paymentTotals.find((row: any) => row.method === "CARD").salesYen, finalized * 1000);
      assert.equal(await spent(d.customer.id), finalized * 1000);
      const duplicateSession = await open(e.salonId, 100);
      const closes = await Promise.all([randomUUID(), randomUUID()].map((requestId) => call("POST", `/api/cash/register-sessions/${duplicateSession.id}/close`, { version: duplicateSession.version, requestId, countedCashYen: 100 }, owner.headers(e.salonId))));
      assert.deepEqual(closes.map((response) => response.statusCode).sort(), [200, 409], closes.map((response) => response.body).join("\n"));
      assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, resourceId: duplicateSession.id, action: "register.close" } }), 1);
    });

    await t.test("authority is rechecked after a transaction lock wait and suspended identities cannot mutate", async () => {
      const actor = await account("revoked", "STAFF", ["checkout.write", "register.read"], [g.salonId]);
      let draft = await create(g.reservation.id, g.salonId);
      draft = await update(draft, [{ method: "CARD", amountYen: 1000, reference: "権限失効検証" }], g.salonId);
      const session = await open(g.salonId, 500);
      let pending: ReturnType<typeof call> | undefined;
      const errorsBefore = databaseErrors.length;
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${tenant.id} FOR UPDATE`;
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        pending = call("POST", `/api/cash/checkouts/${draft.id}/finalize`, {
          version: draft.version, requestId: randomUUID(), registerSessionId: session.id
        }, actor.headers(g.salonId));
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*)::bigint AS count FROM pg_stat_activity a
            WHERE a.datname=current_database() AND ${pid} = ANY(pg_blocking_pids(a.pid))`;
          if (Number(count) > 0) { blocked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(blocked, "Checkout must wait behind the access-management tenant lock before revocation");
        await tx.tenantMembership.update({ where: { tenantId_userId: { tenantId: tenant.id, userId: actor.id } }, data: { permissions: [] } });
      }, { timeout: 15000 });
      assert.ok(pending);
      const denied = await pending;
      assert.equal(denied.statusCode, 403, denied.body);
      assert.ok(databaseErrors.slice(errorsBefore).every((error) => error.databaseCode !== "40001"), "Serializable retries must not escape as HTTP errors");
      assert.equal((await prisma.cashCheckout.findUniqueOrThrow({ where: { id: draft.id } })).status, "DRAFT");
      assert.equal(await spent(g.customer.id), 0);
      assert.equal((await good<Register>("GET", `/api/cash/register-sessions/${session.id}`, undefined, owner.headers(g.salonId))).version, 1);
      const where = { tenantId_userId: { tenantId: tenant.id, userId: actor.id } };
      await prisma.tenantMembership.update({ where, data: { permissions: ["checkout.write"], status: "SUSPENDED" } });
      assert.equal((await call("PUT", `/api/cash/checkouts/${draft.id}`, body(draft, []), actor.headers(g.salonId))).statusCode, 403);
      await prisma.tenantMembership.update({ where, data: { status: "ACTIVE" } });
      await prisma.appUser.update({ where: { id: actor.id }, data: { disabled: true } });
      assert.equal((await call("POST", "/api/cash/checkouts", { reservationId: g.reservation.id, requestId: randomUUID() }, actor.headers(g.salonId))).statusCode, 403);
      await prisma.appUser.update({ where: { id: actor.id }, data: { disabled: false } });
      await prisma.tenant.update({ where: { id: tenant.id }, data: { status: "SUSPENDED" } });
      assert.equal((await call("POST", `/api/cash/checkouts/${draft.id}/finalize`, { version: draft.version, requestId: randomUUID(), registerSessionId: session.id }, actor.headers(g.salonId))).statusCode, 403);
      await prisma.tenant.update({ where: { id: tenant.id }, data: { status: "ACTIVE" } });
    });

    await t.test("point discounts, atomic admin notices and reversals preserve immutable accounting snapshots", async () => {
      const h = await fixture("points-notice", 2200);
      const headers = owner.headers(h.salonId);
      const scope = { tenantId: tenant.id, salonId: h.salonId };
      await prisma.salonSettings.create({ data: { ...scope, storeId: "points-notice", cancellationMessage: "", friendMessage: "",
        notifyReservationEmail: true, notificationEmail: "checkout-admin@example.test" } });
      await prisma.customer.update({ where: { id: h.customer.id }, data: { phone: "090-1234-5678", memo: "非公開顧客メモ" } });
      let checkout = await create(h.reservation.id, h.salonId);
      assert.equal(checkout.pointsDiscountYen, 0);
      const invalid = await call("PUT", `/api/cash/checkouts/${checkout.id}`, body(checkout, [], { pointsDiscountYen: 2201 }), headers);
      assert.equal(invalid.statusCode, 400, invalid.body);
      assert.equal((await good<Receipt>("GET", `/api/cash/checkouts/${checkout.id}`, undefined, headers)).version, checkout.version);
      checkout = await update(checkout, [{ method: "CASH", amountYen: 500, reference: "" }, { method: "CARD", amountYen: 1500, reference: "非公開決済参照" }], h.salonId, {
        items: [{ label: "施術", quantity: 1, unitPriceYen: 1200, discountYen: 100, taxRate: 10 },
          { label: "店販", quantity: 1, unitPriceYen: 1080, discountYen: 0, taxRate: 8 }], pointsDiscountYen: 180, notes: "非公開会計メモ"
      });
      assert.deepEqual([checkout.totalYen, checkout.pointsDiscountYen, checkout.taxYen], [2000, 180, 164]);
      assert.deepEqual(checkout.items.map((item) => item.pointsDiscountYen), [91, 89]);
      const { pointsDiscountYen: _points, ...legacyBody } = body(checkout, checkout.payments);
      checkout = await good<Receipt>("PUT", `/api/cash/checkouts/${checkout.id}`, legacyBody, headers);
      assert.equal(checkout.pointsDiscountYen, 180); assert.equal(checkout.totalYen, 2000);
      const { pointsDiscountYen: _preserved, ...smallerLegacyBody } = body(checkout, [], {
        items: [{ label: "金額を減らした旧画面", quantity: 1, unitPriceYen: 100, discountYen: 0, taxRate: 10 }]
      });
      assert.equal((await call("PUT", `/api/cash/checkouts/${checkout.id}`, smallerLegacyBody, headers)).statusCode, 400);
      checkout = await update(checkout, checkout.payments, h.salonId, { pointsDiscountYen: 0 });
      assert.equal(checkout.pointsDiscountYen, 0); assert.equal(checkout.totalYen, 2180);
      checkout = await update(checkout, checkout.payments, h.salonId, { pointsDiscountYen: 180 });
      const register = await open(h.salonId);
      const finalize = { version: checkout.version, requestId: randomUUID(), registerSessionId: register.id };
      // A queue write failure must roll back the settlement and its register/customer effects.
      const collision = await prisma.emailOutbox.create({ data: { ...scope, eventKey: `checkout.finalized:${checkout.id}`,
        eventType: "checkout.finalized", recipientEmail: "fixture@example.test", payload: {} } });
      assert.equal((await call("POST", `/api/cash/checkouts/${checkout.id}/finalize`, finalize, headers)).statusCode, 409);
      assert.equal((await good<Receipt>("GET", `/api/cash/checkouts/${checkout.id}`, undefined, headers)).status, "DRAFT");
      assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: h.reservation.id } })).paymentStatus, "UNPAID");
      assert.equal(await spent(h.customer.id), 0);
      assert.equal(await prisma.cashRegisterMovement.count({ where: { ...scope, checkoutId: checkout.id } }), 0);
      assert.equal((await good<Register>("GET", `/api/cash/register-sessions/${register.id}`, undefined, headers)).version, 1);
      await prisma.emailOutbox.delete({ where: { id: collision.id } });
      await prisma.customer.update({ where: { id: h.customer.id }, data: { name: "会計確定時の顧客" } });
      const finalized = await Promise.all([call("POST", `/api/cash/checkouts/${checkout.id}/finalize`, finalize, headers), call("POST", `/api/cash/checkouts/${checkout.id}/finalize`, finalize, headers)]);
      assert.deepEqual(finalized.map((response) => response.statusCode), [200, 200], finalized.map((response) => response.body).join("\n"));
      checkout = finalized[0].json(); assert.equal(await spent(h.customer.id), 2000);
      const notice = await prisma.emailOutbox.findUniqueOrThrow({ where: { eventKey: `checkout.finalized:${checkout.id}` } });
      assert.equal(notice.recipientEmail, "checkout-admin@example.test"); assert.equal(notice.tenantId, tenant.id); assert.equal(notice.salonId, h.salonId);
      const snapshot = notice.payload as Record<string, unknown>;
      assert.equal(snapshot.customerName, "会計確定時の顧客"); assert.equal(snapshot.serviceName, h.service.name); assert.equal(snapshot.staffName, "指名なし");
      assert.deepEqual([snapshot.subtotalYen, snapshot.discountYen, snapshot.pointsDiscountYen, snapshot.totalYen, snapshot.taxYen], [2280, 100, 180, 2000, 164]);
      assert.deepEqual(snapshot.payments, [{ method: "CASH", amountYen: 500 }, { method: "CARD", amountYen: 1500 }]);
      for (const excluded of ["090-1234-5678", "非公開顧客メモ", "非公開決済参照", "非公開会計メモ"]) assert(!JSON.stringify(snapshot).includes(excluded));
      await prisma.customer.update({ where: { id: h.customer.id }, data: { name: "後日変更した顧客名" } });
      await prisma.service.update({ where: { id: h.service.id }, data: { price: 3400, name: "後日変更メニュー" } });
      await prisma.salonSettings.update({ where: { tenantId_salonId: scope }, data: { notificationEmail: "updated-admin@example.test" } });
      const reverse = { requestId: randomUUID(), reason: "テスト訂正", refundRecorded: true, registerSessionId: register.id };
      const reversed = await Promise.all([call("POST", `/api/cash/checkouts/${checkout.id}/reverse`, reverse, headers), call("POST", `/api/cash/checkouts/${checkout.id}/reverse`, reverse, headers)]);
      assert.deepEqual(reversed.map((response) => response.statusCode), [200, 200], reversed.map((response) => response.body).join("\n"));
      assert.equal(await spent(h.customer.id), 0);
      const reversalNotice = await prisma.emailOutbox.findUniqueOrThrow({ where: { eventKey: `checkout.reversed:${checkout.id}` } });
      assert.equal(reversalNotice.recipientEmail, "updated-admin@example.test");
      const reversal = reversalNotice.payload as Record<string, unknown>;
      for (const field of ["customerName", "serviceName", "subtotalYen", "discountYen", "pointsDiscountYen", "totalYen", "taxYen", "payments"]) assert.deepEqual(reversal[field], snapshot[field]);
      assert.deepEqual((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: notice.id } })).payload, snapshot);
      assert.equal(await prisma.emailOutbox.count({ where: scope }), 2);
      let correction = await create(h.reservation.id, h.salonId);
      assert.equal(correction.supersedesCheckoutId, checkout.id); assert.equal(correction.pointsDiscountYen, 0);
      correction = await update(correction, [{ method: "CARD", amountYen: 1000, reference: "訂正会計" }], h.salonId, {
        items: [{ label: "訂正施術", quantity: 1, unitPriceYen: 1100, discountYen: 0, taxRate: 10 }], pointsDiscountYen: 100
      });
      await good("POST", `/api/cash/checkouts/${correction.id}/finalize`, { version: correction.version, requestId: randomUUID(), registerSessionId: register.id }, headers);
      assert.equal(await spent(h.customer.id), 1000); assert.equal(await prisma.emailOutbox.count({ where: scope }), 3);
      const updatedRegister = await good<Register>("GET", `/api/cash/register-sessions/${register.id}`, undefined, headers);
      const closed = await good<Register>("POST", `/api/cash/register-sessions/${register.id}/close`, { version: updatedRegister.version, requestId: randomUUID(), countedCashYen: 5000 }, headers);
      assert.deepEqual([closed.closeSnapshot.salesTotalYen, closed.closeSnapshot.refundsTotalYen, closed.closeSnapshot.netTotalYen], [3000, 2000, 1000]);
      assert.deepEqual([closed.closeSnapshot.discountYen, closed.closeSnapshot.pointsDiscountYen, closed.closeSnapshot.refundsPointsDiscountYen], [100, 280, 180]);
    });

    await t.test("all-points checkout sends zero-sale snapshots with no payment and disabled admin notices stay disabled", async () => {
      const h = await fixture("all-points", 1000);
      const headers = owner.headers(h.salonId); const scope = { tenantId: tenant.id, salonId: h.salonId };
      await prisma.salonSettings.create({ data: { ...scope, storeId: "all-points", cancellationMessage: "", friendMessage: "",
        notifyReservationEmail: true, notificationEmail: "points-admin@example.test" } });
      let checkout = await create(h.reservation.id, h.salonId);
      checkout = await update(checkout, [], h.salonId, { pointsDiscountYen: 1000 });
      const register = await open(h.salonId);
      checkout = await good<Receipt>("POST", `/api/cash/checkouts/${checkout.id}/finalize`, { version: checkout.version, requestId: randomUUID(), registerSessionId: register.id }, headers);
      assert.equal(checkout.totalYen, 0); assert.equal(checkout.taxYen, 0); assert.equal(await spent(h.customer.id), 0);
      assert.equal(await prisma.cashRegisterMovement.count({ where: scope }), 0);
      const payload = (await prisma.emailOutbox.findUniqueOrThrow({ where: { eventKey: `checkout.finalized:${checkout.id}` } })).payload as Record<string, unknown>;
      assert.equal(payload.totalYen, 0); assert.equal(payload.pointsDiscountYen, 1000); assert.deepEqual(payload.payments, []);
      await prisma.salonSettings.update({ where: { tenantId_salonId: scope }, data: { notifyReservationEmail: false } });
      await good("POST", `/api/cash/checkouts/${checkout.id}/reverse`, { requestId: randomUUID(), reason: "テスト取消", refundRecorded: true, registerSessionId: register.id }, headers);
      assert.equal(await prisma.emailOutbox.count({ where: { eventKey: `checkout.reversed:${checkout.id}` } }), 0);
      let correction = await create(h.reservation.id, h.salonId);
      correction = await update(correction, [{ method: "CARD", amountYen: 1000, reference: "通常精算" }], h.salonId);
      await good("POST", `/api/cash/checkouts/${correction.id}/finalize`, { version: correction.version, requestId: randomUUID(), registerSessionId: register.id }, headers);
      assert.equal(await prisma.emailOutbox.count({ where: scope }), 1);
    });

    await t.test("a historical receipt refunds into today's register without rewriting the old close", async () => {
      const headers = owner.headers(f.salonId);
      const yesterday = businessDateAt(new Date(Date.now() - 86_400_000), "Asia/Tokyo");
      // An imported historical opening is fixture data, not a bypass added to the API.
      const pastRegister = await prisma.cashRegisterSession.create({ data: { tenantId: tenant.id, salonId: f.salonId,
        businessDate: yesterday, openingCashYen: 5000, openedByUserId: owner.id, createRequestId: randomUUID() } });
      let past = await create(f.reservation.id, f.salonId);
      past = await update(past, [{ method: "CASH", amountYen: 2000, reference: "過去の入金記録" }], f.salonId);
      await prisma.$transaction(async (tx) => {
        await tx.cashCheckout.update({ where: { id: past.id }, data: { status: "FINALIZED", version: { increment: 1 },
          finalizedAt: new Date(Date.now() - 86_400_000), finalizedByUserId: owner.id, finalizedSessionId: pastRegister.id,
          finalizeRequestId: randomUUID(), finalizeRequestHash: "historical-fixture" } });
        await tx.cashRegisterMovement.create({ data: { tenantId: tenant.id, salonId: f.salonId, sessionId: pastRegister.id,
          checkoutId: past.id, kind: "SALE", amountYen: 2000, reason: "過去の会計", createdByUserId: owner.id, requestId: randomUUID(), requestHash: "historical-fixture" } });
        await tx.reservation.update({ where: { id: f.reservation.id }, data: { paymentStatus: "PAID" } });
      });
      const closedPast = await good<Register>("POST", `/api/cash/register-sessions/${pastRegister.id}/close`, { version: pastRegister.version, requestId: randomUUID(), countedCashYen: 7000 }, headers);
      const frozen = closedPast.closeSnapshot;
      let current = await open(f.salonId, 5000);
      await good("POST", `/api/cash/checkouts/${past.id}/reverse`, { requestId: randomUUID(), reason: "過去会計の全額返金確認", refundRecorded: true, registerSessionId: current.id }, headers);
      assert.deepEqual((await good<Register>("GET", `/api/cash/register-sessions/${pastRegister.id}`, undefined, headers)).closeSnapshot, frozen);
      current = await good<Register>("GET", `/api/cash/register-sessions/${current.id}`, undefined, headers);
      assert.equal(current.expectedCashYen, 3000);
      const currentClose = await good<Register>("POST", `/api/cash/register-sessions/${current.id}/close`, { version: current.version, requestId: randomUUID(), countedCashYen: 3000 }, headers);
      assert.equal(currentClose.closeSnapshot.salesTotalYen, 0); assert.equal(currentClose.closeSnapshot.refundsTotalYen, 2000);
      assert.equal(currentClose.closeSnapshot.netTotalYen, -2000); assert.equal(currentClose.closeSnapshot.refundsCount, 1);
      assert.equal(currentClose.closeSnapshot.paymentTotals.find((row: any) => row.method === "CASH").refundsYen, 2000);
      assert.equal(await spent(f.customer.id), 0);
    });
  } finally {
    await server.close(); auth.mock.restore();
    // Only this run's fixture tenants are removed. Never reset or truncate shared data.
    if (tenantIds.length) {
      const where = { tenantId: { in: tenantIds } };
      await prisma.emailOutbox.deleteMany({ where });
      await prisma.cashRegisterMovement.deleteMany({ where });
      await prisma.cashCheckoutItem.deleteMany({ where });
      await prisma.cashPaymentAllocation.deleteMany({ where });
      const checkouts = await prisma.cashCheckout.findMany({ where, orderBy: { createdAt: "desc" }, select: { id: true, tenantId: true } });
      for (const checkout of checkouts) await prisma.cashCheckout.deleteMany({ where: { id: checkout.id, tenantId: checkout.tenantId } });
      await prisma.cashRegisterSession.deleteMany({ where });
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
