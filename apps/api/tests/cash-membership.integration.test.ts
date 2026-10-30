import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { businessDateAt } from "../src/cash-domain.js";
import { MEMBERSHIP_POLICY } from "../src/membership-domain.js";

const databaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname.endsWith("_test"), "An explicit local _test database is required.");
}
type Receipt = any;

test("membership redemptions, cash settlement and refunds share one PostgreSQL transaction", { skip: !databaseUrl }, async (t) => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")]);
  server.log.level = "silent";
  const databaseErrors: unknown[] = [];
  server.addHook("onError", async (_request, _reply, error) => {
    if (error.name === "PrismaClientKnownRequestError") {
      const problem = error as Error & { code?: string; meta?: unknown };
      databaseErrors.push({ code: problem.code, meta: problem.meta });
    }
  });
  const prefix = `cash-member-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [], programIds: string[] = [], userIds: string[] = [];
  const identity = { uid: prefix, email: `${prefix}@example.test`, name: "ポイント会計担当", email_verified: true };
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => { assert.equal(credential, prefix); return identity; });
  try {
    const program = await prisma.membershipProgram.create({ data: { slug: prefix, name: "テナント内共通ポイント検証" } }); programIds.push(program.id);
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "会社A", membershipProgramId: program.id } }); tenantIds.push(tenant.id);
    const otherTenant = tenant;
    const foreignProgram = await prisma.membershipProgram.create({ data: { slug: `${prefix}-foreign`, name: "別ポイント制度" } }); programIds.push(foreignProgram.id);
    const foreignTenant = await prisma.tenant.create({ data: { slug: `${prefix}-foreign`, name: "別テナント", membershipProgramId: foreignProgram.id } }); tenantIds.push(foreignTenant.id);
    const owner = await prisma.appUser.create({ data: { firebaseUid: prefix, email: identity.email, displayName: identity.name } }); userIds.push(owner.id);
    for (const id of tenantIds) await prisma.tenantMembership.create({ data: { tenantId: id, userId: owner.id, role: "OWNER" } });
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "店舗A", timezone: "Asia/Tokyo" } });
    const otherSalon = await prisma.salon.create({ data: { tenantId: otherTenant.id, name: "店舗B", timezone: "Asia/Tokyo" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    const foreignScope = { tenantId: otherTenant.id, salonId: otherSalon.id };
    const headersFor = (other = false) => ({ authorization: `Bearer ${prefix}`, "x-tenant-slug": other ? otherTenant.slug : tenant.slug, "x-salon-id": other ? otherSalon.id : salon.id });
    async function call(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, other = false) {
      return server.inject({ method, url: path, headers: headersFor(other), ...(payload === undefined ? {} : { payload }) });
    }
    async function good(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, other = false, expected = 200): Promise<Receipt> {
      const response = await call(method, path, payload, other); assert.equal(response.statusCode, expected, `${method} ${path}: ${response.body}`); return response.json();
    }
    async function member(openingPoints: number, programId = program.id) {
      const account = await prisma.membershipAccount.create({ data: { programId, projectId: "salon-reserve-bg", uid: randomUUID(), displayName: "会員テスト" } });
      if (openingPoints) await prisma.membershipPointEntry.create({ data: { ...scope, programId, accountId: account.id, kind: "EARN", delta: openingPoints, requestId: randomUUID(), createdByUserId: owner.id } });
      return account;
    }
    const startsAt = new Date(`${businessDateAt(new Date(), "Asia/Tokyo")}T11:00:00+09:00`);
    async function sale(account: Awaited<ReturnType<typeof member>>, price: number, options: { other?: boolean; link?: boolean; customerId?: string } = {}) {
      const currentScope = options.other ? foreignScope : scope;
      const customer = options.customerId ? await prisma.customer.findUniqueOrThrow({ where: { id: options.customerId } })
        : await prisma.customer.create({ data: { ...currentScope, name: "会計のお客様", kana: "カイケイ" } });
      if (options.link !== false && !options.customerId) await prisma.membershipCustomerLink.create({ data: { ...currentScope, programId: account.programId, accountId: account.id, customerId: customer.id, linkedByUserId: owner.id } });
      const service = await prisma.service.create({ data: { ...currentScope, name: "施術", category: "会計検証", price, durationMinutes: 60, color: "#111111" } });
      const reservation = await prisma.reservation.create({ data: { ...currentScope, customerId: customer.id, serviceId: service.id, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), status: "COMPLETED" } });
      return { customer, reservation, other: options.other ?? false };
    }
    const choice = (accountId: string, pointsToUse: number, extra = {}) => ({ membershipAccountId: accountId, pointUseDecision: pointsToUse ? "USE" : "SKIP", pointsToUse, pointPolicyVersion: MEMBERSHIP_POLICY.version, ...extra });
    async function create(entry: Awaited<ReturnType<typeof sale>>, selection?: ReturnType<typeof choice>) {
      return good("POST", "/api/cash/checkouts", { reservationId: entry.reservation.id, requestId: randomUUID(), ...selection }, entry.other, 201);
    }
    function body(checkout: Receipt, payments: unknown[], extra = {}) {
      return { version: checkout.version, items: checkout.items.map(({ label, quantity, unitPriceYen, discountYen, taxRate }: any) => ({ label, quantity, unitPriceYen, discountYen, taxRate })),
        payments, legacyPaidAcknowledged: false, notes: "", ...extra };
    }
    const register = await good("POST", "/api/cash/register-sessions", { businessDate: businessDateAt(new Date(), "Asia/Tokyo"), openingCashYen: 10000, requestId: randomUUID() });
    const otherRegister = await good("POST", "/api/cash/register-sessions", { businessDate: businessDateAt(new Date(), "Asia/Tokyo"), openingCashYen: 10000, requestId: randomUUID() }, true);
    const balance = async (accountId: string) => (await prisma.membershipPointEntry.aggregate({ where: { accountId }, _sum: { delta: true } }))._sum.delta ?? 0;
    const finalize = (checkout: Receipt, other = false, requestId = randomUUID()) => call("POST", `/api/cash/checkouts/${checkout.id}/finalize`, { version: checkout.version, requestId, registerSessionId: other ? otherRegister.id : register.id }, other);

    await t.test("read and draft writes do not debit; selection, link, policy and units are required", async () => {
      const account = await member(2000); const entry = await sale(account, 2000);
      assert.equal((await call("POST", "/api/cash/checkouts", { reservationId: entry.reservation.id, requestId: randomUUID(), membershipAccountId: account.id })).statusCode, 400);
      assert.equal((await call("POST", "/api/cash/checkouts", { reservationId: entry.reservation.id, requestId: randomUUID(), ...choice(account.id, 50) })).statusCode, 400);
      const oldPolicy = await call("POST", "/api/cash/checkouts", { reservationId: entry.reservation.id, requestId: randomUUID(), ...choice(account.id, 100, { pointPolicyVersion: "old" }) });
      assert.equal(oldPolicy.statusCode, 409); assert.equal(oldPolicy.json().code, "CASH_POINT_POLICY_CHANGED");
      const unlinked = await sale(account, 2000, { link: false });
      const unlinkedResponse = await call("POST", "/api/cash/checkouts", { reservationId: unlinked.reservation.id, requestId: randomUUID(), ...choice(account.id, 100) });
      assert.equal(unlinkedResponse.statusCode, 409); assert.equal(unlinkedResponse.json().code, "MEMBERSHIP_CUSTOMER_MISMATCH");
      const foreign = await member(0, foreignProgram.id);
      assert.equal((await call("POST", "/api/cash/checkouts", { reservationId: entry.reservation.id, requestId: randomUUID(), ...choice(foreign.id, 0) })).statusCode, 409);
      let checkout = await create(entry, choice(account.id, 1000));
      assert.equal(checkout.pointsDiscountYen, 1000); assert.equal(checkout.totalYen, 1000); assert.equal(checkout.membership.decision, "USE");
      await good("GET", `/api/cash/checkouts/${checkout.id}`); assert.equal(await balance(account.id), 2000);
      assert.equal((await call("PUT", `/api/cash/checkouts/${checkout.id}`, body(checkout, [], { pointsDiscountYen: 999 }))).statusCode, 400);
      checkout = await good("PUT", `/api/cash/checkouts/${checkout.id}`, body(checkout, [{ method: "CARD", amountYen: 1000, reference: "確認" }]));
      assert.equal(checkout.pointsDiscountYen, 1000); assert.equal(checkout.membership.pointsToUse, 1000); assert.equal(await balance(account.id), 2000);
      const key = randomUUID(); const responses = await Promise.all([finalize(checkout, false, key), finalize(checkout, false, key)]);
      assert.deepEqual(responses.map((response) => response.statusCode), [200, 200], responses.map((response) => response.body).join("\n"));
      const settled = responses[0].json(); assert.equal(settled.membership.pointsAwarded, 50); assert.equal(await balance(account.id), 1050);
      assert.equal(await prisma.membershipPointEntry.count({ where: { checkoutId: checkout.id } }), 2);
      assert.equal((await finalize(checkout)).statusCode, 409);
      const reverse = { requestId: randomUUID(), reason: "全額取消確認", refundRecorded: true, registerSessionId: register.id };
      const reversed = await Promise.all([call("POST", `/api/cash/checkouts/${checkout.id}/reverse`, reverse), call("POST", `/api/cash/checkouts/${checkout.id}/reverse`, reverse)]);
      assert.deepEqual(reversed.map((response) => response.statusCode), [200, 200], reversed.map((response) => response.body).join("\n"));
      assert.equal(await balance(account.id), 2000); assert.equal(await prisma.membershipPointEntry.count({ where: { checkoutId: checkout.id } }), 4);
    });

    await t.test("finalization rechecks the current link and rolls back points when payment validation fails", async () => {
      const account = await member(500); const entry = await sale(account, 1000); let checkout = await create(entry, choice(account.id, 500));
      assert.equal((await finalize(checkout)).statusCode, 400); assert.equal(await balance(account.id), 500);
      assert.equal(await prisma.membershipPointEntry.count({ where: { checkoutId: checkout.id } }), 0);
      checkout = await good("PUT", `/api/cash/checkouts/${checkout.id}`, body(checkout, [{ method: "CASH", amountYen: 500 }]));
      await prisma.membershipCustomerLink.deleteMany({ where: { accountId: account.id } });
      assert.equal((await finalize(checkout)).statusCode, 409); assert.equal(await balance(account.id), 500);
      assert.equal((await prisma.cashCheckout.findUniqueOrThrow({ where: { id: checkout.id } })).status, "DRAFT");
      assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: entry.reservation.id } })).paymentStatus, "UNPAID");
    });

    await t.test("two salons in one tenant cannot simultaneously spend the same shared balance", async () => {
      const account = await member(500); const left = await sale(account, 500); const right = await sale(account, 500, { other: true });
      const a = await create(left, choice(account.id, 500)); const b = await create(right, choice(account.id, 500));
      const responses = await Promise.all([finalize(a), finalize(b, true)]);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409], JSON.stringify({ responses: responses.map((response) => response.body), databaseErrors }));
      assert.equal(await balance(account.id), 0); assert.equal(await prisma.membershipPointEntry.count({ where: { accountId: account.id, kind: "REDEEM" } }), 1);
      assert.equal(await prisma.cashCheckout.count({ where: { id: { in: [a.id, b.id] }, status: "FINALIZED" } }), 1);
    });

    await t.test("a late settlement failure rolls back the redemption, earning, register and reservation together", async () => {
      const account = await member(500); const entry = await sale(account, 1000);
      let checkout = await create(entry, choice(account.id, 100));
      checkout = await good("PUT", `/api/cash/checkouts/${checkout.id}`, body(checkout, [{ method: "CASH", amountYen: 900 }]));
      await prisma.salonSettings.create({ data: { ...scope, storeId: `${prefix}-notice`, cancellationMessage: "", friendMessage: "", notifyReservationEmail: true, notificationEmail: "fixture@example.test" } });
      const collision = await prisma.emailOutbox.create({ data: { ...scope, eventKey: `checkout.finalized:${checkout.id}`, eventType: "checkout.finalized", recipientEmail: "fixture@example.test", payload: {} } });
      const response = await finalize(checkout); assert.equal(response.statusCode, 409, response.body);
      assert.equal(await balance(account.id), 500);
      assert.equal(await prisma.membershipPointEntry.count({ where: { checkoutId: checkout.id } }), 0);
      assert.equal(await prisma.cashRegisterMovement.count({ where: { checkoutId: checkout.id } }), 0);
      assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: entry.reservation.id } })).paymentStatus, "UNPAID");
      assert.equal((await prisma.cashCheckout.findUniqueOrThrow({ where: { id: checkout.id } })).status, "DRAFT");
      await prisma.emailOutbox.delete({ where: { id: collision.id } });
      assert.equal((await finalize(checkout)).statusCode, 200); assert.equal(await balance(account.id), 445);
      await prisma.salonSettings.update({ where: { tenantId_salonId: scope }, data: { notifyReservationEmail: false } });
    });

    await t.test("spent earnings can be reversed without blocking a cash refund or returning spendable debt", async () => {
      const account = await member(0); const earnedSale = await sale(account, 2000); let earning = await create(earnedSale, choice(account.id, 0));
      earning = await good("PUT", `/api/cash/checkouts/${earning.id}`, body(earning, [{ method: "CASH", amountYen: 2000 }]));
      assert.equal((await finalize(earning)).statusCode, 200); assert.equal(await balance(account.id), 100);
      const spentSale = await sale(account, 100, { other: true }); const spent = await create(spentSale, choice(account.id, 100));
      assert.equal((await finalize(spent, true)).statusCode, 200); assert.equal(await balance(account.id), 0);
      await prisma.membershipCustomerLink.deleteMany({ where: { accountId: account.id } });
      await prisma.membershipAccount.update({ where: { id: account.id }, data: { active: false } });
      const response = await call("POST", `/api/cash/checkouts/${earning.id}/reverse`, { requestId: randomUUID(), reason: "提供取消と返金を確認", refundRecorded: true, registerSessionId: register.id });
      assert.equal(response.statusCode, 200, response.body); assert.equal(await balance(account.id), -100);
      const { membershipBalance } = await import("../src/membership-domain.js");
      assert.equal((await membershipBalance(prisma, account.id, program.id)).availablePoints, 0);
      assert.equal((await prisma.cashCheckout.findUniqueOrThrow({ where: { id: earning.id } })).status, "REVERSED");
    });

    await t.test("already-paid reservations permit explicit skip but reject a new point redemption", async () => {
      const account = await member(500); const entry = await sale(account, 1000);
      await prisma.reservation.update({ where: { id: entry.reservation.id }, data: { paymentStatus: "PAID" } });
      const rejected = await call("POST", "/api/cash/checkouts", { reservationId: entry.reservation.id, requestId: randomUUID(), ...choice(account.id, 100) });
      assert.equal(rejected.statusCode, 409, rejected.body); assert.equal(rejected.json().code, "CASH_PREPAID_POINT_USE_UNAVAILABLE");
      let checkout = await create(entry, choice(account.id, 0));
      assert.equal((await call("PUT", `/api/cash/checkouts/${checkout.id}`, body(checkout, [], choice(account.id, 100)))).statusCode, 409);
      checkout = await good("PUT", `/api/cash/checkouts/${checkout.id}`, body(checkout, [{ method: "EXTERNAL_PREPAYMENT", amountYen: 1000, reference: "既入金確認" }], { legacyPaidAcknowledged: true }));
      assert.equal((await finalize(checkout)).statusCode, 200); assert.equal(await balance(account.id), 550);
      assert.equal(await prisma.membershipPointEntry.count({ where: { checkoutId: checkout.id, kind: "REDEEM" } }), 0);
      const changed = await sale(account, 1000, { customerId: entry.customer.id });
      let beforePayment = await create(changed, choice(account.id, 100));
      beforePayment = await good("PUT", `/api/cash/checkouts/${beforePayment.id}`, body(beforePayment, [{ method: "EXTERNAL_PREPAYMENT", amountYen: 900, reference: "別途入金の記録" }], { legacyPaidAcknowledged: true }));
      await prisma.reservation.update({ where: { id: changed.reservation.id }, data: { paymentStatus: "PAID" } });
      const stale = await finalize(beforePayment); assert.equal(stale.statusCode, 409, stale.body); assert.match(stale.json().message, /入金済み.*ポイント/);
      assert.equal(await balance(account.id), 550);
      assert.equal(await prisma.membershipPointEntry.count({ where: { checkoutId: beforePayment.id } }), 0);
    });

    await t.test("legacy yen discounts remain money records and do not mutate any membership ledger", async () => {
      const account = await member(1000); const entry = await sale(account, 1000); let checkout = await create(entry);
      checkout = await good("PUT", `/api/cash/checkouts/${checkout.id}`, body(checkout, [{ method: "CARD", amountYen: 820 }], { pointsDiscountYen: 180 }));
      assert.equal(checkout.membership, null); assert.equal((await finalize(checkout)).statusCode, 200);
      assert.equal(await balance(account.id), 1000); assert.equal(await prisma.membershipPointEntry.count({ where: { checkoutId: checkout.id } }), 0);
    });
  } finally {
    await server.close(); auth.mock.restore();
    if (tenantIds.length) {
      const where = { tenantId: { in: tenantIds } };
      // ALTER and cleanup share one transaction/table lock, so another test
      // cannot observe the append-only trigger disabled.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "MembershipPointEntry" DISABLE TRIGGER USER');
        await tx.membershipPointEntry.deleteMany({ where: { ...where, reversalOfId: { not: null } } });
        await tx.membershipPointEntry.deleteMany({ where });
        await tx.$executeRawUnsafe('ALTER TABLE "MembershipPointEntry" ENABLE TRIGGER USER');
        await tx.emailOutbox.deleteMany({ where });
        await tx.cashRegisterMovement.deleteMany({ where });
        await tx.cashCheckoutItem.deleteMany({ where });
        await tx.cashPaymentAllocation.deleteMany({ where });
        await tx.cashCheckout.deleteMany({ where });
        await tx.cashRegisterSession.deleteMany({ where });
        await tx.membershipCustomerLink.deleteMany({ where });
        await tx.reservation.deleteMany({ where });
        await tx.customer.deleteMany({ where });
        await tx.service.deleteMany({ where });
        await tx.salon.deleteMany({ where });
        await tx.membershipAccount.deleteMany({ where: { programId: { in: programIds } } });
        await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
        await tx.membershipProgram.deleteMany({ where: { id: { in: programIds } } });
      });
    }
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
