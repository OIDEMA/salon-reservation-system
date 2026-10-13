import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("existing reservation and customer routes enforce operations permissions", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")
  ]);
  const prefix = `legacy-${randomUUID().slice(0, 8)}`;
  const users: string[] = [];
  const identities = new Map<string, { uid: string; email: string; email_verified: boolean; name: string }>();
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    const claims = identities.get(credential); assert(claims); return claims;
  });
  let tenantId: string | undefined;
  try {
    const tenant = await prisma.tenant.create({ data: { name: "操作権限テスト", slug: prefix } }); tenantId = tenant.id;
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "検証店舗" } });
    async function account(name: string, permissions: string[], role: "OWNER" | "STAFF" | "VIEWER" = "STAFF") {
      const uid = `${prefix}-${name}`;
      identities.set(uid, { uid, name, email: `${uid}@example.test`, email_verified: true });
      const user = await prisma.appUser.create({ data: { firebaseUid: uid, email: `${uid}@example.test`, displayName: name } }); users.push(user.id);
      await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role, useCustomPermissions: role !== "OWNER", permissions } });
      return { authorization: `Bearer ${uid}`, "x-tenant-slug": tenant.slug, "x-salon-id": salon.id };
    }
    const owner = await account("owner", [], "OWNER");
    const booking = await account("booking", ["reservation.write", "customer.write"]);
    const reservationOnly = await account("reservation-only", ["reservation.write"]);
    const viewer = await account("viewer", ["reservation.read", "customer.read"], "VIEWER");
    const scope = { tenantId: tenant.id, salonId: salon.id };
    const customer = await prisma.customer.create({ data: { ...scope, name: "既存顧客", kana: "コキャク", memo: "private-chart-marker", totalSpent: 9999 } });
    const service = await prisma.service.create({ data: { ...scope, name: "既存メニュー", category: "施術", durationMinutes: 30, price: 5000, color: "#111111" } });
    const input = { date: "2026-10-15", startTime: "11:00", durationMinutes: 30, customerName: customer.name, customerId: customer.id, serviceId: service.id, serviceName: service.name, status: "COMPLETED" };
    async function post(headers: typeof owner, payload: unknown) { return server.inject({ method: "POST", url: "/api/reservations", headers, payload }); }
    const created = await post(owner, input); assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id;
    await t.test("unauthenticated and read-only writes are denied by actual global hooks", async () => {
      assert.equal((await server.inject({ method: "POST", url: "/api/reservations", payload: input })).statusCode, 401);
      assert.equal((await post(viewer, input)).statusCode, 403);
      assert.equal((await server.inject({ method: "POST", url: "/api/admin/menus", headers: booking, payload: {} })).statusCode, 403);
      assert.equal((await server.inject({ url: "/api/charts", headers: booking })).statusCode, 403);
      assert.equal((await server.inject({ url: "/api/cash/checkouts", headers: booking })).statusCode, 403);
    });
    await t.test("reservation routes cannot set payment status, and completion does not fabricate spend", async () => {
      assert.equal((await post(owner, { ...input, paymentStatus: "PAID" })).statusCode, 409);
      const paid = await server.inject({ method: "PATCH", url: `/api/reservations/${id}`, headers: owner, payload: { paymentStatus: "PAID" } });
      assert.equal(paid.statusCode, 409, paid.body);
      const completed = await server.inject({ method: "PATCH", url: `/api/reservations/${id}/status`, headers: owner, payload: { status: "COMPLETED" } });
      assert.equal(completed.statusCode, 200, completed.body);
      const stored = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
      assert.equal(stored.totalSpent, 0); assert.equal(stored.visitCount, 1);
      assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id } })).paymentStatus, "UNPAID");
    });
    await t.test("reservation memo never writes a clinical customer memo and master creation requires permission", async () => {
      const response = await post(booking, { ...input, customerId: undefined, customerName: "予約新規顧客", memo: "予約連絡事項" });
      assert.equal(response.statusCode, 201, response.body);
      const saved = await prisma.customer.findUniqueOrThrow({ where: { id: response.json().customer.id } });
      assert.equal(saved.memo, null); assert.equal(response.json().memo, "予約連絡事項");
      assert.equal((await post(reservationOnly, { ...input, customerId: undefined, customerName: "登録できない顧客" })).statusCode, 403);
      assert.equal((await post(booking, { ...input, serviceId: undefined, serviceName: "登録できないメニュー" })).statusCode, 403);
      assert.equal(await prisma.service.count({ where: { ...scope, name: "登録できないメニュー" } }), 0);
      assert.equal((await post(owner, { ...input, customerId: "foreign-customer" })).statusCode, 400);
      assert.equal((await post(owner, { ...input, serviceId: "foreign-menu" })).statusCode, 400);
    });
    await t.test("customer memo and spend require read privileges including search and embedded reservations", async () => {
      const patch = await server.inject({ method: "PATCH", url: `/api/admin/customers/${customer.id}`, headers: booking, payload: { name: customer.name, memo: "forbidden" } });
      assert.equal(patch.statusCode, 403, patch.body);
      const detail = await server.inject({ url: `/api/admin/customers/${customer.id}`, headers: booking });
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(detail.json().memo, null); assert.equal(detail.json().totalSpent, null);
      const search = await server.inject({ url: "/api/admin/customers?q=private-chart-marker", headers: booking });
      assert.equal(search.statusCode, 200); assert.equal(search.json().length, 0);
      const reservation = await server.inject({ url: `/api/reservations/${id}`, headers: booking });
      assert.equal(reservation.statusCode, 200); assert(!reservation.body.includes("private-chart-marker"));
      const allowed = await server.inject({ url: `/api/admin/customers/${customer.id}`, headers: owner });
      assert.equal(allowed.json().memo, "private-chart-marker"); assert.equal(allowed.json().totalSpent, 0);
    });
  } finally {
    await server.close(); auth.mock.restore();
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } });
    if (users.length) await prisma.appUser.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  }
});
