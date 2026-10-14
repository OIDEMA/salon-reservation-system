import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { z } from "zod";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("all master lists page/search in the database and enforce master/salon access", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"),
    "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  const [{ prisma }, { firebaseAdminAuth }, { registerMasterPageRoutes }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/master-page.js")
  ]);
  const server = Fastify({ logger: false });
  server.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : 500).send({ message: "Invalid request" }));
  registerMasterPageRoutes(server);
  const prefix = `master-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [], userIds: string[] = [];
  const claims = new Map<string, { uid: string; email: string; email_verified: boolean }>();
  const sessionMock = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => { const claim = claims.get(credential); assert(claim); return claim; });
  const tokenMock = t.mock.method(firebaseAdminAuth, "verifyIdToken", async () => { throw new Error("Unknown test credential"); });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "マスター一覧検証" } }); tenantIds.push(tenant.id);
    const foreignTenant = await prisma.tenant.create({ data: { slug: `${prefix}-foreign`, name: "別テナント" } }); tenantIds.push(foreignTenant.id);
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "許可外店舗", createdAt: new Date("2020-01-01") } });
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "許可店舗" } });
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "別テナント店舗" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    async function account(name: string, permissions: string[]) {
      const uid = `${prefix}-${name}`;
      claims.set(uid, { uid, email: `${uid}@example.test`, email_verified: true });
      const user = await prisma.appUser.create({ data: { firebaseUid: uid, email: `${uid}@example.test` } }); userIds.push(user.id);
      await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions, salonIds: [salon.id] } });
      return { authorization: `Bearer ${uid}`, "x-tenant-slug": tenant.slug, "x-salon-id": salon.id };
    }
    const reader = await account("reader", ["master.read"]);
    const reservationOnly = await account("reservation", ["reservation.read"]);
    const data = Array.from({ length: 125 }, (_, index) => ({ ...scope, id: `${prefix}-${index}`, sortOrder: index,
      name: index === 124 ? "フェイシャル_100%" : `通常項目${index}` }));
    await prisma.staff.createMany({ data: data.map((row, index) => ({ ...row, kana: "フェイシャル", role: index === 124 ? "ESTHETICIAN" : "STYLIST", color: "#123456", active: index !== 124, comment: "一覧には不要な長い説明" })) });
    await prisma.service.createMany({ data: data.map((row, index) => ({ ...row, category: index === 124 ? "特殊カテゴリ" : "通常", durationMinutes: 30, price: 5000, color: "#123456", active: index !== 124, description: "一覧には不要な長い説明", imageUrl: "https://example.test/image" })) });
    await prisma.menuCategory.createMany({ data: data.map((row, index) => ({ ...row, type: index === 124 ? "OPTION" : "MENU", enabled: index !== 124, description: index === 124 ? "特殊カテゴリ" : "通常", imageUrl: "https://example.test/image" })) });
    await prisma.equipment.createMany({ data: data.map((row, index) => ({ ...row, active: index !== 124, memo: index === 124 ? "特殊メモ" : "通常" })) });
    for (const otherScope of [{ tenantId: tenant.id, salonId: otherSalon.id }, { tenantId: foreignTenant.id, salonId: foreignSalon.id }]) {
      await prisma.staff.create({ data: { ...otherScope, name: "フェイシャル_100%", kana: "", role: "ESTHETICIAN", color: "#123456" } });
      await prisma.service.create({ data: { ...otherScope, name: "フェイシャル_100%", category: "特殊カテゴリ", durationMinutes: 30, price: 0, color: "#123456" } });
      await prisma.menuCategory.create({ data: { ...otherScope, name: "フェイシャル_100%", type: "OPTION" } });
      await prisma.equipment.create({ data: { ...otherScope, name: "フェイシャル_100%" } });
    }
    const get = (resource: string, query = "", headers: Record<string, string> = reader) => server.inject({ method: "GET", url: `/api/admin/${resource}/page${query ? `?${query}` : ""}`, headers });
    for (const resource of ["staff", "menus", "categories", "equipment"]) {
      await t.test(`${resource}: bounded pages, literal normalized search, state filter and lightweight fields`, async () => {
        const firstResponse = await get(resource); assert.equal(firstResponse.statusCode, 200, firstResponse.body);
        assert.equal(firstResponse.headers["cache-control"], "private, no-store");
        const first = firstResponse.json(); assert.deepEqual([first.total, first.pageSize, first.totalPages, first.items.length], [125, 50, 3, 50]);
        const ids = new Set<string>();
        for (const page of [1, 2, 3]) for (const row of (await get(resource, `page=${page}`)).json().items) { assert(!ids.has(row.id)); ids.add(row.id); }
        assert.equal(ids.size, 125);
        const last = (await get(resource, "page=999")).json(); assert.deepEqual([last.page, last.items.length], [3, 25]);
        const result = (await get(resource, `q=${encodeURIComponent("ﾌｪｲｼｬﾙ_１００%")}`)).json();
        assert.equal(result.total, 1); assert.equal(result.items[0].id, `${prefix}-124`);
        const literal = (await get(resource, "q=%25")).json(); assert.equal(literal.total, 1);
        const inactive = (await get(resource, "status=INACTIVE")).json(); assert.equal(inactive.total, 1);
        assert.equal((await get(resource, "status=ACTIVE")).json().total, 124);
        const empty = (await get(resource, "q=nomatch&page=20")).json();
        assert.deepEqual(empty, { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 });
        assert(!("tenantId" in first.items[0])); assert(!("imageUrl" in first.items[0]));
        if (resource === "staff") assert(!("comment" in first.items[0]));
        if (resource === "menus") assert(!("description" in first.items[0]));
      });
      await t.test(`${resource}: authentication, permissions and cross-salon/tenant requests fail closed`, async () => {
        assert.equal((await get(resource, "", {})).statusCode, 401);
        assert.equal((await get(resource, "", reservationOnly)).statusCode, 403);
        assert.equal((await get(resource, "", { ...reader, "x-salon-id": otherSalon.id })).statusCode, 403);
        assert.equal((await get(resource, "", { ...reader, "x-salon-id": foreignSalon.id })).statusCode, 403);
        assert.equal((await get(resource, "", { ...reader, "x-tenant-slug": foreignTenant.slug })).statusCode, 403);
        const fallback = (await get(resource, "", { authorization: reader.authorization, "x-tenant-slug": tenant.slug })).json(); assert.equal(fallback.total, 125);
      });
    }
    await t.test("resource type filters and invalid query bounds", async () => {
      for (const [resource, type] of [["staff", "ESTHETICIAN"], ["menus", "特殊カテゴリ"], ["categories", "OPTION"]]) {
        const result = (await get(resource, `type=${encodeURIComponent(type)}`)).json(); assert.equal(result.total, 1);
      }
      assert.equal((await get("equipment", "type=OPTION")).statusCode, 400);
      for (const query of ["page=0", "page=abc", "pageSize=101", "status=broken", `q=${"a".repeat(101)}`, "unknown=1"]) {
        assert.equal((await get("menus", query)).statusCode, 400, query);
      }
    });
  } finally {
    await server.close(); sessionMock.mock.restore(); tokenMock.mock.restore();
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
