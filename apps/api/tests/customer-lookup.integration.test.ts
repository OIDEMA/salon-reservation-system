import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("registered customer lookup and reservation linkage enforce scope and privileges", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")
  ]);
  const prefix = `lookup-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const identities = new Map<string, { uid: string; email: string; email_verified: boolean; name: string }>();
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    const claims = identities.get(credential); assert(claims); return claims;
  });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "顧客検索検証" } }); tenantIds.push(tenant.id);
    const foreignTenant = await prisma.tenant.create({ data: { slug: `${prefix}-foreign`, name: "別テナント" } }); tenantIds.push(foreignTenant.id);
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "範囲外店舗", createdAt: new Date("2020-01-01T00:00:00Z") } });
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "許可店舗" } });
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "別テナント店舗" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    async function account(name: string, permissions: string[]) {
      const uid = `${prefix}-${name}`;
      identities.set(uid, { uid, name, email: `${uid}@example.test`, email_verified: true });
      const user = await prisma.appUser.create({ data: { firebaseUid: uid, email: `${uid}@example.test` } }); userIds.push(user.id);
      await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions, salonIds: [salon.id] } });
      return { authorization: `Bearer ${uid}`, "x-tenant-slug": tenant.slug, "x-salon-id": salon.id };
    }
    const booking = await account("booking", ["reservation.write", "customer.read"]);
    const customerWriter = await account("customer-writer", ["reservation.write", "customer.write"]);
    const reservationOnly = await account("reservation-only", ["reservation.write"]);
    const reader = await account("reader", ["customer.read"]);
    const customer = await prisma.customer.create({ data: { ...scope, name: "山田 花子", kana: "ﾔﾏﾀﾞ ﾊﾅｺ", phone: "０９０－１２３４－５６７８",
      lineDisplayName: "非公開LINE", tags: ["非公開タグ"], memo: "非公開カルテ", totalSpent: 9999 } });
    const literal = await prisma.customer.create({ data: { ...scope, name: "記号%_!顧客", kana: "キゴウ" } });
    await prisma.customer.create({ data: { ...scope, name: "Ａｌｉｃｅ", kana: "アリス", phone: "03 (5555) 1234" } });
    const foreign = await prisma.customer.create({ data: { tenantId: foreignTenant.id, salonId: foreignSalon.id, name: customer.name, kana: customer.kana, phone: customer.phone } });
    await prisma.customer.create({ data: { tenantId: tenant.id, salonId: otherSalon.id, name: customer.name, kana: customer.kana, phone: customer.phone } });
    for (const foreignScope of [{ tenantId: tenant.id, salonId: otherSalon.id }, { tenantId: foreignTenant.id, salonId: foreignSalon.id }]) {
      await prisma.customer.create({ data: { ...foreignScope, name: "範囲外同番号顧客", kana: "ハンイガイ", phone: "０７０－２２２２－３３３３" } });
    }
    const get = (q: string, headers: Record<string, string> = booking) => server.inject({ method: "GET", url: `/api/admin/customers/lookup?q=${encodeURIComponent(q)}`, headers });

    await t.test("name, kana width/script and phone formatting find registered records with narrow fields", async () => {
      for (const q of ["山田", "山田花子", "やまだ", "ﾊﾅｺ", "ヤマダ ハナコ", "0901234", "０９０（１２３４）５６７８"]) {
        const response = await get(q); assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert.deepEqual(Object.keys(response.json()).sort(), ["customers", "hasMore"]);
        assert.equal(response.json().hasMore, false);
        assert.deepEqual(response.json().customers.map((row: { id: string }) => row.id), [customer.id]);
        assert.deepEqual(Object.keys(response.json().customers[0]).sort(), ["id", "kana", "name", "phone"]);
        for (const secret of ["非公開LINE", "非公開タグ", "非公開カルテ", "totalSpent", "visitCount"]) assert(!response.body.includes(secret));
      }
      assert.equal((await get("alice")).json().customers[0].name, "Ａｌｉｃｅ");
      assert.equal((await get("03-5555")).json().customers[0].phone, "03 (5555) 1234");
      assert.deepEqual((await get("%_!")).json().customers.map((row: { id: string }) => row.id), [literal.id]);
      assert.deepEqual((await get("' OR 1=1 --")).json(), { customers: [], hasMore: false });
      assert.deepEqual((await get("　")).json(), { customers: [], hasMore: false });
      assert.deepEqual((await get("9")).json(), { customers: [], hasMore: false });
      assert.equal((await get("a".repeat(101))).statusCode, 400);
      assert.equal((await get("a\0b")).statusCode, 400);
    });
    await t.test("bounded lookup indicates extra matches without returning more than 20", async () => {
      await prisma.customer.createMany({ data: Array.from({ length: 22 }, (_, index) => ({ ...scope, name: `候補検証${index}`, kana: `コウホ${String(index).padStart(2, "0")}` })) });
      const response = (await get("候補検証")).json();
      assert.equal(response.customers.length, 20); assert.equal(response.hasMore, true);
      assert.equal(new Set(response.customers.map((row: { id: string }) => row.id)).size, 20);
    });
    await t.test("customer read permission and tenant/salon boundaries fail closed", async () => {
      assert.equal((await get("山田", {})).statusCode, 401);
      assert.equal((await get("山田", reservationOnly)).statusCode, 403);
      assert.equal((await get("山田", reader)).statusCode, 200);
      assert.equal((await get("山田", { ...booking, "x-salon-id": otherSalon.id })).statusCode, 403);
      assert.equal((await get("山田", { ...booking, "x-salon-id": foreignSalon.id })).statusCode, 403);
      assert.equal((await get("山田", { ...booking, "x-tenant-slug": foreignTenant.slug, "x-salon-id": foreignSalon.id })).statusCode, 403);
      const fallback = await get("山田", { authorization: booking.authorization, "x-tenant-slug": tenant.slug });
      assert.equal(fallback.statusCode, 200, fallback.body);
      assert.deepEqual(fallback.json().customers.map((row: { id: string }) => row.id), [customer.id]);
    });
    await t.test("selected customerId preserves the registered record and prevents duplicate creation", async () => {
      const service = await prisma.service.create({ data: { ...scope, name: "登録サービス", category: "施術", durationMinutes: 30, price: 5000, color: "#111111" } });
      const payload = { date: "2026-10-20", startTime: "12:00", durationMinutes: 30, status: "CONFIRMED", customerId: customer.id,
        requireCustomerSelection: true, customerName: "クライアント表示の別名", customerKana: "別のカナ", customerPhone: customer.phone, serviceId: service.id, serviceName: service.name };
      const countBefore = await prisma.customer.count({ where: scope });
      const response = await server.inject({ method: "POST", url: "/api/reservations", headers: booking, payload });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json().customer.id, customer.id); assert.equal(response.json().customer.name, customer.name);
      assert.equal(response.json().customer.kana, customer.kana); assert.equal(response.json().customer.phone, customer.phone);
      assert.equal(await prisma.customer.count({ where: scope }), countBefore);
      const stored = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
      assert.equal(stored.name, customer.name); assert.equal(stored.kana, customer.kana); assert.equal(stored.phone, customer.phone); assert.equal(stored.memo, customer.memo);
      const rejected = await server.inject({ method: "POST", url: "/api/reservations", headers: booking, payload: { ...payload, customerId: foreign.id } });
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.equal(await prisma.reservation.count({ where: scope }), 1);
      assert.equal(await prisma.customer.count({ where: scope }), countBefore);
      for (const phone of [customer.phone, "09012345678", "090-1234-5678"]) {
        const collision = await server.inject({ method: "POST", url: "/api/reservations", headers: customerWriter,
          payload: { ...payload, customerId: undefined, customerName: "同番号の別人", customerPhone: phone } });
        assert.equal(collision.statusCode, 409, collision.body);
        assert(collision.json().message.includes("検索候補からお客様を選択"));
        assert.equal(await prisma.reservation.count({ where: scope }), 1);
        assert.equal(await prisma.customer.count({ where: scope }), countBefore);
      }
      const fresh = await server.inject({ method: "POST", url: "/api/reservations", headers: customerWriter,
        payload: { ...payload, customerId: undefined, customerName: "未登録の新規顧客", customerPhone: "070-2222-3333" } });
      assert.equal(fresh.statusCode, 201, fresh.body);
      assert.notEqual(fresh.json().customer.id, customer.id);
      assert.equal(await prisma.customer.count({ where: scope }), countBefore + 1);
      const legacy = await server.inject({ method: "POST", url: "/api/reservations", headers: booking,
        payload: { ...payload, customerId: undefined, requireCustomerSelection: undefined } });
      assert.equal(legacy.statusCode, 201, legacy.body);
      assert.equal(legacy.json().customer.id, customer.id);
      assert.equal(await prisma.customer.count({ where: scope }), countBefore + 1);
      assert.equal(await prisma.reservation.count({ where: scope }), 3);
    });
  } finally {
    await server.close(); auth.mock.restore();
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
