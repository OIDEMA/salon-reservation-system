import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("reservation catalog follows booking permission, tenant/salon scope and registered master data", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")
  ]);
  const prefix = `catalog-${randomUUID().slice(0, 8)}`;
  const tenants: string[] = [];
  const users: string[] = [];
  const identities = new Map<string, { uid: string; email: string; email_verified: boolean; name: string }>();
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    const claims = identities.get(credential); assert(claims); return claims;
  });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "予約カタログ検証" } }); tenants.push(tenant.id);
    const foreignTenant = await prisma.tenant.create({ data: { slug: `${prefix}-foreign`, name: "別テナント検証" } }); tenants.push(foreignTenant.id);
    // The first salon is deliberately outside the test member's scope, to verify
    // the no-salon-header fallback never leaks the tenant's first salon.
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "範囲外店舗", createdAt: new Date("2020-01-01T00:00:00Z") } });
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "許可店舗" } });
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "別テナント店舗" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    async function account(name: string, permissions: string[]) {
      const uid = `${prefix}-${name}`;
      identities.set(uid, { uid, name, email: `${uid}@example.test`, email_verified: true });
      const user = await prisma.appUser.create({ data: { firebaseUid: uid, email: `${uid}@example.test` } }); users.push(user.id);
      await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions, salonIds: [salon.id] } });
      return { authorization: `Bearer ${uid}`, "x-tenant-slug": tenant.slug, "x-salon-id": salon.id };
    }
    const reader = await account("reader", ["reservation.read"]);
    const writer = await account("writer", ["reservation.write"]);
    const masterOnly = await account("master-only", ["master.read"]);
    const active = await prisma.service.create({ data: { ...scope, name: "有効メニュー", category: "登録カテゴリ", durationMinutes: 30, price: 9800,
      color: "#111111", active: true, sortOrder: 20, menuType: "通常メニュー", lineVisible: true, unlimitedBooking: false } });
    const stopped = await prisma.service.create({ data: { ...scope, name: "所要時間確認中", category: "停止カテゴリ", durationMinutes: 60, price: 5500,
      color: "#222222", active: false, sortOrder: 10, menuType: "初回", lineVisible: false, unlimitedBooking: true, description: "所要時間を確認してから有効化" } });
    const secondCategory = await prisma.menuCategory.create({ data: { ...scope, name: "登録カテゴリ", type: "MENU", enabled: true, sortOrder: 20 } });
    const firstCategory = await prisma.menuCategory.create({ data: { ...scope, name: "停止カテゴリ", type: "MENU", enabled: false, sortOrder: 10 } });
    const emptyCategory = await prisma.menuCategory.create({ data: { ...scope, name: "メニュー未登録カテゴリ", type: "MENU", enabled: true, sortOrder: 30 } });
    await prisma.menuCategory.create({ data: { ...scope, name: "オプションカテゴリ", type: "OPTION", enabled: true, sortOrder: 0 } });
    const staff = await prisma.staff.create({ data: { ...scope, name: "対応スタッフ", kana: "タイオウ", role: "ESTHETICIAN", color: "#333333", active: true } });
    await prisma.staff.create({ data: { ...scope, name: "停止スタッフ", kana: "テイシ", role: "ESTHETICIAN", color: "#444444", active: false } });
    for (const [tenantId, salonId] of [[tenant.id, otherSalon.id], [foreignTenant.id, foreignSalon.id]]) {
      await prisma.service.create({ data: { tenantId, salonId, name: "範囲外メニュー", category: "範囲外", durationMinutes: 30, price: 1000, color: "#555555" } });
      await prisma.menuCategory.create({ data: { tenantId, salonId, name: "範囲外カテゴリ", type: "MENU" } });
      await prisma.staff.create({ data: { tenantId, salonId, name: "範囲外スタッフ", kana: "ハンイガイ", role: "ESTHETICIAN", color: "#555555" } });
    }
    const get = (headers: Record<string, string> = reader) => server.inject({ method: "GET", url: "/api/reservation-catalog", headers });

    await t.test("reservation.read alone can obtain the catalog while master routes remain forbidden", async () => {
      const response = await get();
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal((await server.inject({ url: "/api/admin/menus", headers: reader })).statusCode, 403);
      assert.equal((await server.inject({ url: "/api/admin/categories", headers: reader })).statusCode, 403);
      assert.equal((await server.inject({ url: "/api/admin/staff", headers: reader })).statusCode, 403);
    });
    await t.test("inactive menus and all MENU categories retain registered order and booking fields", async () => {
      const { menus, categories, staff: catalogStaff } = (await get()).json();
      assert.deepEqual(menus.map((menu: { id: string }) => menu.id), [stopped.id, active.id]);
      assert.equal(menus[0].active, false); assert.equal(menus[0].durationMinutes, 60); assert.equal(menus[0].price, 5500);
      assert.equal(menus[0].menuType, "初回"); assert.equal(menus[0].lineVisible, false); assert.equal(menus[0].unlimitedBooking, true);
      assert.equal(menus[0].description, stopped.description); assert.equal(menus[1].unlimitedBooking, false);
      assert.deepEqual(categories.map((category: { id: string }) => category.id), [firstCategory.id, secondCategory.id, emptyCategory.id]);
      assert.equal(categories[0].enabled, false);
      assert(categories.every((category: { type: string }) => category.type === "MENU"));
      assert.deepEqual(catalogStaff.map((member: { id: string }) => member.id), [staff.id]);
      for (const rows of [menus, categories, catalogStaff]) assert(rows.every((row: { tenantId: string; salonId: string }) => row.tenantId === tenant.id && row.salonId === salon.id));
    });
    await t.test("tenant and salon boundaries are enforced including omitted salon headers", async () => {
      assert.equal((await get({ ...reader, "x-salon-id": otherSalon.id })).statusCode, 403);
      assert.equal((await get({ ...reader, "x-salon-id": foreignSalon.id })).statusCode, 403);
      assert.equal((await get({ ...reader, "x-tenant-slug": foreignTenant.slug, "x-salon-id": foreignSalon.id })).statusCode, 403);
      const fallback = await get({ authorization: reader.authorization, "x-tenant-slug": tenant.slug });
      assert.equal(fallback.statusCode, 200, fallback.body);
      assert.deepEqual(fallback.json().menus.map((menu: { id: string }) => menu.id), [stopped.id, active.id]);
      const tenantIdHeader = await get({ authorization: reader.authorization, "x-tenant-id": tenant.id });
      assert.equal(tenantIdHeader.statusCode, 200, tenantIdHeader.body);
      assert.deepEqual(tenantIdHeader.json().menus.map((menu: { id: string }) => menu.id), [stopped.id, active.id]);
    });
    await t.test("unauthenticated or missing reservation permission is denied by the global hook", async () => {
      assert.equal((await get({})).statusCode, 401);
      const denied = await get(masterOnly);
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(denied.json().code, "PERMISSION_DENIED");
    });
    await t.test("showing an inactive menu does not allow creating a reservation for it", async () => {
      const customer = await prisma.customer.create({ data: { ...scope, name: "予約検証顧客", kana: "コキャク" } });
      const response = await server.inject({ method: "POST", url: "/api/reservations", headers: writer, payload: {
        date: "2026-10-20", startTime: "12:00", durationMinutes: 60, status: "CANCELLED",
        customerId: customer.id, customerName: customer.name, serviceId: stopped.id, serviceName: stopped.name
      } });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(await prisma.reservation.count({ where: scope }), 0);
      assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: stopped.id } })).active, false);
    });
  } finally {
    await server.close(); auth.mock.restore();
    if (tenants.length) await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    if (users.length) await prisma.appUser.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  }
});
