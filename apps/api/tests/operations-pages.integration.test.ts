import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("reservation and checkout pages keep lists bounded and searchable across the full history", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")
  ]);
  server.log.level = "silent";
  const prefix = `lists-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const identities = new Map<string, { uid: string; email: string; email_verified: boolean }>();
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    const claims = identities.get(credential); assert(claims); return claims;
  });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "業務一覧検証" } }); tenantIds.push(tenant.id);
    const foreignTenant = await prisma.tenant.create({ data: { slug: `${prefix}-foreign`, name: "別テナント" } }); tenantIds.push(foreignTenant.id);
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "別店舗", createdAt: new Date("2020-01-01T00:00:00Z") } });
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "許可店舗" } });
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "別テナント店舗" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    async function account(name: string, permissions: string[]) {
      const uid = `${prefix}-${name}`;
      identities.set(uid, { uid, email: `${uid}@example.test`, email_verified: true });
      const user = await prisma.appUser.create({ data: { firebaseUid: uid, email: `${uid}@example.test` } }); userIds.push(user.id);
      await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions, salonIds: [salon.id] } });
      return { id: user.id, headers: { authorization: `Bearer ${uid}`, "x-tenant-slug": tenant.slug, "x-salon-id": salon.id } };
    }
    const reservationReader = await account("reservations", ["reservation.read"]);
    const checkoutReader = await account("checkouts", ["checkout.read"]);
    const customerReader = await account("customers", ["customer.read"]);
    const registerReader = await account("registers", ["register.read"]);
    const oldCustomer = await prisma.customer.create({ data: { ...scope, name: "最古予約顧客", kana: "サイコヨヤク", phone: "090-0000-0000", memo: "非公開顧客メモ" } });
    const customer = await prisma.customer.create({ data: { ...scope, name: "通常予約顧客", kana: "ツウジョウ", memo: "非公開顧客メモ" } });
    const service = await prisma.service.create({ data: { ...scope, name: "一覧施術", category: "検証", durationMinutes: 30, price: 5000, color: "#111111", description: "非公開メニュー説明" } });
    const staff = await prisma.staff.create({ data: { ...scope, name: "検証担当", kana: "ケンショウ", role: "ESTHETICIAN", color: "#111111", comment: "非公開スタッフメモ" } });
    await prisma.reservation.createMany({ data: Array.from({ length: 1005 }, (_, index) => ({
      ...scope, id: `${prefix}-r-${String(index).padStart(4, "0")}`,
      customerId: index === 0 ? oldCustomer.id : customer.id, serviceId: service.id, staffId: staff.id,
      startsAt: new Date(Date.UTC(2020, 0, index + 1, 3)), endsAt: new Date(Date.UTC(2020, 0, index + 1, 3, 30)),
      status: index === 0 ? "CONFIRMED" as const : index === 1 ? "CANCELLED" as const : index === 2 ? "NO_SHOW" as const : "COMPLETED" as const,
      source: "PHONE" as const, memo: index === 0 ? "最古予約メモ検索" : null
    })) });
    const checkoutIds = Array.from({ length: 220 }, () => randomUUID());
    await prisma.cashCheckout.createMany({ data: checkoutIds.map((id, index) => ({
      ...scope, id, reservationId: `${prefix}-r-${String(index).padStart(4, "0")}`,
      reservationSnapshot: { customerName: index === 0 ? "旧会計顧客" : "通常会計顧客", serviceName: "履歴保存施術", staffName: "検証担当", internalDetail: "非公開会計snapshot詳細" },
      status: index === 0 ? "FINALIZED" as const : "DRAFT" as const, totalYen: 5000,
      legacyPaymentStatus: "UNPAID", taxBreakdown: [], createRequestId: randomUUID(), createdByUserId: checkoutReader.id,
      createdAt: new Date(Date.UTC(2020, 0, index + 1)), notes: "非公開会計メモ"
    })) });
    await prisma.cashCheckoutItem.create({ data: { ...scope, checkoutId: checkoutIds[0], lineNumber: 1, label: "非公開明細", quantity: 1, unitPriceYen: 5000, discountYen: 0, taxRate: 10, totalYen: 5000, taxYen: 454 } });
    await prisma.cashPaymentAllocation.create({ data: { ...scope, checkoutId: checkoutIds[0], method: "CARD", amountYen: 5000, reference: "非公開カード参照" } });
    for (const foreignScope of [{ tenantId: tenant.id, salonId: otherSalon.id }, { tenantId: foreignTenant.id, salonId: foreignSalon.id }]) {
      const foreignCustomer = await prisma.customer.create({ data: { ...foreignScope, name: "最古予約顧客", kana: "サイコヨヤク" } });
      const foreignService = await prisma.service.create({ data: { ...foreignScope, name: service.name, category: "検証", durationMinutes: 30, price: 5000, color: "#111111" } });
      const foreignReservation = await prisma.reservation.create({ data: { ...foreignScope, customerId: foreignCustomer.id, serviceId: foreignService.id, startsAt: new Date("2020-01-01T03:00:00Z"), endsAt: new Date("2020-01-01T03:30:00Z") } });
      await prisma.cashCheckout.create({ data: { ...foreignScope, reservationId: foreignReservation.id, reservationSnapshot: { customerName: "旧会計顧客", serviceName: "履歴保存施術" }, legacyPaymentStatus: "UNPAID", taxBreakdown: [], createRequestId: randomUUID(), createdByUserId: checkoutReader.id } });
    }
    const registerIds = Array.from({ length: 120 }, () => randomUUID());
    await prisma.cashRegisterSession.createMany({ data: registerIds.map((id, index) => ({
      ...scope, id, businessDate: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
      status: "CLOSED" as const, openingCashYen: 1000, expectedCashYen: 1000 + index, differenceYen: 0,
      countedCashYen: 1000 + index, note: index === 0 ? "最古レジメモ" : "非公開締めメモ",
      closeSnapshot: { secret: "非公開レジsnapshot" }, createRequestId: randomUUID(), openedByUserId: registerReader.id
    })) });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const openRegister = await prisma.cashRegisterSession.create({ data: { ...scope, businessDate: today, status: "OPEN", openingCashYen: 1000,
      expectedCashYen: 99999, createRequestId: randomUUID(), openedByUserId: registerReader.id } });
    await prisma.cashRegisterMovement.createMany({ data: ([
      { kind: "IN" as const, amountYen: 100 }, { kind: "SALE" as const, amountYen: 200 },
      { kind: "OUT" as const, amountYen: 50 }, { kind: "REFUND" as const, amountYen: 20 }
    ]).map((movement) => ({ ...scope, sessionId: openRegister.id, ...movement, reason: "非公開入出金理由",
      requestId: randomUUID(), requestHash: "test-fixture", createdByUserId: registerReader.id })) });
    // Fresh bulk-loaded tables have no planner statistics until autovacuum runs.
    // Collect them deterministically: the checkout's relation searches otherwise
    // choose costly correlated scans and can exceed the transaction deadline.
    for (const table of ["Customer", "Reservation", "Service", "CashCheckout"]) {
      await prisma.$executeRawUnsafe(`ANALYZE public."${table}"`);
    }
    const get = (url: string, headers: Record<string, string> = reservationReader.headers) => server.inject({ method: "GET", url, headers });

    await t.test("reservation page is bounded, complete and does not serialize detail fields", async () => {
      const checksBefore = auth.mock.callCount();
      const first = await get("/api/reservations/page"); assert.equal(first.statusCode, 200, first.body);
      assert.equal(auth.mock.callCount() - checksBefore, 1, "the real permission hook and page handler share one Firebase check per HTTP request");
      assert.equal(first.headers["cache-control"], "private, no-store");
      assert.deepEqual([first.json().total, first.json().page, first.json().pageSize, first.json().totalPages, first.json().reservations.length], [1005, 1, 50, 21, 50]);
      const seen = new Set<string>();
      for (let page = 1; page <= 21; page++) for (const row of (await get(`/api/reservations/page?page=${page}`)).json().reservations) {
        assert(!seen.has(row.id)); seen.add(row.id);
        assert.deepEqual(Object.keys(row.customer).sort(), ["id", "kana", "name", "phone"]);
        assert.deepEqual(Object.keys(row.service).sort(), ["id", "name", "price"]);
        assert.deepEqual(Object.keys(row.staff).sort(), ["id", "name"]);
        assert(!("memo" in row));
      }
      assert.equal(seen.size, 1005);
      assert.equal((await get("/api/reservations/page?page=99999")).json().page, 21);
      assert(!first.body.includes("非公開"));
    });
    await t.test("reservation q/status/date search works across history beyond the legacy limit", async () => {
      const legacy = (await get("/api/reservations")).json(); assert.equal(legacy.length, 1000);
      assert(!legacy.some((row: { id: string }) => row.id === `${prefix}-r-0000`));
      for (const q of ["最古予約顧客", "サイコヨヤク", "090-0000", "最古予約メモ検索"]) {
        const result = (await get(`/api/reservations/page?q=${encodeURIComponent(q)}`)).json();
        assert.equal(result.total, 1); assert.equal(result.reservations[0].id, `${prefix}-r-0000`);
      }
      assert.equal((await get("/api/reservations/page?status=CONFIRMED")).json().total, 1);
      const dates = (await get("/api/reservations/page?dateFrom=2020-01-02&dateTo=2020-01-04")).json();
      assert.equal(dates.total, 3); assert.deepEqual(dates.reservations.map((row: { date: string }) => row.date), ["2020-01-04", "2020-01-03", "2020-01-02"]);
      const empty = (await get("/api/reservations/page?q=存在しない予約&page=100")).json();
      assert.deepEqual(empty, { reservations: [], total: 0, page: 1, pageSize: 50, totalPages: 1 });
    });
    await t.test("checkout page retains all history without fetching items/payments/notes", async () => {
      const getCash = async (query = "") => {
        const started = performance.now();
        const response = await get(`/api/cash/checkouts/page${query ? `?${query}` : ""}`, checkoutReader.headers);
        const durationMs = Math.round(performance.now() - started);
        if (query.startsWith("q=")) t.diagnostic(JSON.stringify({ checkoutSearch: query, durationMs, status: response.statusCode }));
        assert.equal(response.statusCode, 200, JSON.stringify({ query, durationMs, body: response.body }));
        return response;
      };
      const first = await getCash(); assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual([first.json().total, first.json().pageSize, first.json().totalPages, first.json().checkouts.length], [220, 50, 5, 50]);
      const seen = new Set<string>();
      for (let page = 1; page <= 5; page++) for (const row of (await getCash(`page=${page}`)).json().checkouts) {
        assert(!seen.has(row.id)); seen.add(row.id);
        assert.deepEqual(Object.keys(row).sort(), ["createdAt", "customerName", "id", "reservationId", "serviceName", "status", "totalYen"]);
      }
      assert.equal(seen.size, 220); assert(!first.body.includes("非公開"));
      for (const q of ["旧会計顧客", "最古予約顧客", "090-0000"]) {
        const result = (await getCash(`q=${encodeURIComponent(q)}`)).json();
        assert.equal(result.total, 1); assert.equal(result.checkouts[0].id, checkoutIds[0]);
      }
      assert.equal((await getCash("status=FINALIZED")).json().total, 1);
      assert.equal((await getCash("q=履歴保存施術")).json().total, 220);
      const detail = await get(`/api/cash/checkouts/${checkoutIds[0]}`, checkoutReader.headers);
      assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().items.length, 1); assert.equal(detail.json().payments.length, 1);
      const legacy = await get("/api/cash/checkouts", checkoutReader.headers); assert.equal(legacy.json().length, 200);
    });
    await t.test("checkout reservation candidates search on demand and never return more than 20", async () => {
      const result = await get("/api/reservations/options"); assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().reservations.length, 20); assert.equal(result.json().hasMore, true);
      const old = (await get(`/api/reservations/options?q=${encodeURIComponent("最古予約顧客")}`)).json();
      assert.equal(old.reservations.length, 1); assert.equal(old.hasMore, false);
      assert.deepEqual(Object.keys(old.reservations[0]).sort(), ["customerName", "date", "id", "serviceName", "startTime"]);
      assert.equal(old.reservations[0].id, `${prefix}-r-0000`);
      for (const id of [`${prefix}-r-0001`, `${prefix}-r-0002`]) assert(!result.json().reservations.some((row: { id: string }) => row.id === id));
      assert.equal((await get(`/api/reservations/options?q=${encodeURIComponent("最古予約メモ検索")}`)).json().reservations.length, 0);
      assert.equal((await get("/api/reservations/options", checkoutReader.headers)).statusCode, 403);
    });
    await t.test("register page covers history beyond 90 and aggregates only open registers without details", async () => {
      const getRegisters = (query = "") => get(`/api/cash/register-sessions/page${query ? `?${query}` : ""}`, registerReader.headers);
      const first = await getRegisters(); assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual([first.json().total, first.json().pageSize, first.json().totalPages, first.json().registers.length], [121, 50, 3, 50]);
      const seen = new Set<string>();
      for (let page = 1; page <= 3; page++) for (const row of (await getRegisters(`page=${page}`)).json().registers) {
        assert(!seen.has(row.id)); seen.add(row.id);
        assert.deepEqual(Object.keys(row).sort(), ["businessDate", "differenceYen", "expectedCashYen", "id", "openingCashYen", "status"]);
      }
      assert.equal(seen.size, 121); assert(!first.body.includes("非公開"));
      const open = (await getRegisters("status=OPEN")).json();
      assert.equal(open.total, 1); assert.equal(open.registers[0].expectedCashYen, 1230);
      const old = (await getRegisters(`q=${encodeURIComponent("最古レジメモ")}`)).json();
      assert.equal(old.total, 1); assert.equal(old.registers[0].id, registerIds[0]);
      assert.equal((await getRegisters("q=2020-01-01")).json().total, 1);
      const legacy = (await get("/api/cash/register-sessions", registerReader.headers)).json();
      assert.equal(legacy.length, 90); assert(!legacy.some((row: { id: string }) => row.id === registerIds[0]));
      const options = await get("/api/cash/register-sessions/options", registerReader.headers);
      assert.equal(options.statusCode, 200, options.body); assert.equal(options.json().length, 1);
      assert.equal(options.json()[0].id, openRegister.id); assert.equal(options.json()[0].expectedCashYen, 1230);
      assert(!("movements" in options.json()[0])); assert(!("closeSnapshot" in options.json()[0]));
      const detail = await get(`/api/cash/register-sessions/${openRegister.id}`, registerReader.headers);
      assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().movements.length, 4);
    });
    await t.test("page endpoints preserve read privileges and tenant/salon boundaries", async () => {
      for (const [url, headers] of [["/api/reservations/page", reservationReader.headers], ["/api/reservations/options", reservationReader.headers], ["/api/cash/checkouts/page", checkoutReader.headers], ["/api/cash/register-sessions/page", registerReader.headers], ["/api/cash/register-sessions/options", registerReader.headers]] as const) {
        assert.equal((await get(url, {})).statusCode, 401);
        assert.equal((await get(url, customerReader.headers)).statusCode, 403);
        assert.equal((await get(url, { ...headers, "x-salon-id": otherSalon.id })).statusCode, 403);
        assert.equal((await get(url, { ...headers, "x-salon-id": foreignSalon.id })).statusCode, 403);
        assert.equal((await get(url, { ...headers, "x-tenant-slug": foreignTenant.slug })).statusCode, 403);
      }
    });
    await t.test("invalid dates, statuses and unbounded page sizes fail without a scan", async () => {
      for (const params of ["page=0", "pageSize=101", "dateFrom=2020-02-30", "dateFrom=2020-02-01&dateTo=2020-01-01", "status=INVALID", `q=${"a".repeat(101)}`]) {
        assert.equal((await get(`/api/reservations/page?${params}`)).statusCode, 400, params);
      }
      for (const params of ["page=0", "pageSize=101", "status=INVALID", `q=${"a".repeat(101)}`]) {
        assert.equal((await get(`/api/cash/checkouts/page?${params}`, checkoutReader.headers)).statusCode, 400, params);
      }
    });
  } finally {
    await server.close(); auth.mock.restore();
    // Financial rows intentionally restrict relational deletion; remove only this
    // test's fixture records before deleting its tenants.
    if (tenantIds.length) {
      const fixtureScope = { tenantId: { in: tenantIds } };
      await prisma.cashRegisterMovement.deleteMany({ where: fixtureScope });
      await prisma.cashPaymentAllocation.deleteMany({ where: fixtureScope });
      await prisma.cashCheckoutItem.deleteMany({ where: fixtureScope });
      await prisma.cashCheckout.deleteMany({ where: fixtureScope });
      await prisma.cashRegisterSession.deleteMany({ where: fixtureScope });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
