import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("customer pages search the full roster with bounded results and scoped privileges", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")
  ]);
  const prefix = `page-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const identities = new Map<string, { uid: string; email: string; email_verified: boolean }>();
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    const claims = identities.get(credential); assert(claims); return claims;
  });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "名簿ページ検証" } }); tenantIds.push(tenant.id);
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
      return { authorization: `Bearer ${uid}`, "x-tenant-slug": tenant.slug, "x-salon-id": salon.id };
    }
    const reader = await account("reader", ["customer.read"]);
    const chartReader = await account("clinical", ["customer.read", "chart.read"]);
    const checkoutReader = await account("accounting", ["customer.read", "checkout.read"]);
    const reservationOnly = await account("reservation", ["reservation.read"]);
    await prisma.customer.createMany({ data: Array.from({ length: 1050 }, (_, index) => ({
      ...scope, id: `${prefix}-${String(index).padStart(4, "0")}`,
      name: index === 0 ? "名簿最古顧客" : `ページ顧客${index}`,
      kana: `ページ${String(index).padStart(4, "0")}`,
      phone: index === 0 ? "090-1234-5678" : null,
      lineDisplayName: index === 0 ? "最古表示名" : null,
      lastVisitAt: new Date(Date.UTC(2020, 0, 1 + index)),
      tags: index === 0 ? ["VIP"] : [], memo: index === 0 ? "非公開カルテ検証" : null
    })) });
    for (const otherScope of [{ tenantId: tenant.id, salonId: otherSalon.id }, { tenantId: foreignTenant.id, salonId: foreignSalon.id }]) {
      await prisma.customer.create({ data: { ...otherScope, name: "範囲外顧客", kana: "ハンイガイ", memo: "非公開カルテ検証", tags: ["VIP"] } });
    }
    const get = (params: string = "", headers: Record<string, string> = reader) => server.inject({ method: "GET", url: `/api/admin/customers/page${params ? `?${params}` : ""}`, headers });

    await t.test("default pages are bounded and together cover all 1050 records", async () => {
      const first = await get(); assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.headers["cache-control"], "private, no-store");
      const firstPage = first.json();
      assert.deepEqual([firstPage.total, firstPage.page, firstPage.pageSize, firstPage.totalPages, firstPage.customers.length], [1050, 1, 50, 21, 50]);
      const seen = new Set<string>();
      for (let page = 1; page <= 21; page++) {
        const response = (await get(`page=${page}`)).json();
        assert.equal(response.page, page); assert.equal(response.customers.length, 50);
        for (const row of response.customers) { assert(!seen.has(row.id)); seen.add(row.id); }
      }
      assert.equal(seen.size, 1050);
      const last = (await get("page=999999")).json();
      assert.equal(last.page, 21); assert.equal(last.customers.length, 50);
      const small = (await get("pageSize=7&page=2")).json();
      assert.equal(small.customers.length, 7); assert.equal(small.pageSize, 7); assert.equal(small.page, 2);
    });
    await t.test("server searches find records outside the old first-500 limit", async () => {
      const legacy = await server.inject({ method: "GET", url: "/api/admin/customers", headers: reader });
      assert.equal(legacy.statusCode, 200, legacy.body); assert.equal(legacy.json().length, 500);
      assert(!legacy.json().some((row: { id: string }) => row.id === `${prefix}-0000`));
      for (const q of ["名簿最古", "ページ0000", "090-1234", "最古表示名", "VIP"]) {
        const result = (await get(`q=${encodeURIComponent(q)}`)).json();
        assert.equal(result.total, 1); assert.equal(result.customers[0].id, `${prefix}-0000`);
      }
      const tagged = (await get("tag=VIP")).json(); assert.equal(tagged.total, 1);
      const empty = (await get("q=存在しない顧客&page=20")).json();
      assert.deepEqual(empty, { customers: [], total: 0, page: 1, pageSize: 50, totalPages: 1 });
    });
    await t.test("summary responses and memo search respect separate clinical/accounting permissions", async () => {
      const summary = (await get()).json().customers[0];
      assert.deepEqual(Object.keys(summary).sort(), ["id", "kana", "lastVisitAt", "lineDisplayName", "name", "phone", "tags", "totalSpent", "visitCount"]);
      assert.equal(summary.totalSpent, null);
      const accounting = (await get("", checkoutReader)).json(); assert.equal(accounting.customers[0].totalSpent, 0);
      const hiddenMemoSearch = (await get(`q=${encodeURIComponent("非公開カルテ検証")}`)).json();
      assert.equal(hiddenMemoSearch.total, 0);
      const clinical = await get(`q=${encodeURIComponent("非公開カルテ検証")}`, chartReader);
      assert.equal(clinical.json().total, 1); assert(!clinical.body.includes("非公開カルテ検証"));
      assert(!("memo" in clinical.json().customers[0]));
      assert(!("reservations" in clinical.json().customers[0]));
    });
    await t.test("tenant and salon boundaries and customer read permission fail closed", async () => {
      assert.equal((await get("", {})).statusCode, 401);
      assert.equal((await get("", reservationOnly)).statusCode, 403);
      assert.equal((await get("", { ...reader, "x-salon-id": otherSalon.id })).statusCode, 403);
      assert.equal((await get("", { ...reader, "x-salon-id": foreignSalon.id })).statusCode, 403);
      assert.equal((await get("", { ...reader, "x-tenant-slug": foreignTenant.slug })).statusCode, 403);
      const fallback = await get("", { authorization: reader.authorization, "x-tenant-slug": tenant.slug });
      assert.equal(fallback.statusCode, 200, fallback.body); assert.equal(fallback.json().total, 1050);
    });
    await t.test("unbounded pages and malformed queries are rejected", async () => {
      for (const query of ["page=0", "page=-1", "page=1.5", "page=abc", "page=1000001", "pageSize=0", "pageSize=101", `q=${"a".repeat(101)}`, `tag=${"a".repeat(31)}`]) {
        assert.equal((await get(query)).statusCode, 400, query);
      }
    });
  } finally {
    await server.close(); auth.mock.restore();
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
