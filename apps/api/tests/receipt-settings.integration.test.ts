import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("receipt issuer settings validate partial writes and preserve settings access boundaries", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl!;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")
  ]);
  server.log.level = "silent";
  const prefix = `issuer-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [], userIds: string[] = [];
  const identities = new Map<string, { uid: string; email: string; email_verified: boolean }>();
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    const identity = identities.get(credential); assert.ok(identity); return identity;
  });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "発行者設定テスト" } }); tenantIds.push(tenant.id);
    const foreignTenant = await prisma.tenant.create({ data: { slug: `${prefix}-foreign`, name: "他テナント" } }); tenantIds.push(foreignTenant.id);
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "表示用店舗名" } });
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "権限外店舗" } });
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "他テナント店舗" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    const saved = await prisma.salonSettings.create({ data: { ...scope, storeId: "immutable-store", openTime: "09:00", closeTime: "20:00", cancellationMessage: "元の取消案内", friendMessage: "元の登録案内", notificationEmail: "existing@example.test" } });
    async function account(name: string, permissions: string[]) {
      const uid = `${prefix}-${name}`;
      identities.set(uid, { uid, email: `${uid}@example.test`, email_verified: true });
      const user = await prisma.appUser.create({ data: { firebaseUid: uid, email: `${uid}@example.test` } }); userIds.push(user.id);
      await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions, salonIds: [salon.id] } });
      return { authorization: `Bearer ${uid}`, "x-tenant-slug": tenant.slug, "x-salon-id": salon.id };
    }
    const writer = await account("writer", ["settings.read", "settings.write"]);
    const reader = await account("reader", ["settings.read"]);
    const cashWriter = await account("cash-writer", ["checkout.read", "checkout.write"]);
    const patch = (payload: unknown, headers: Record<string, string> = writer) => server.inject({ method: "PATCH", url: "/api/admin/settings", headers, payload });
    const read = () => server.inject({ method: "GET", url: "/api/admin/settings", headers: reader });
    const stored = () => prisma.salonSettings.findUniqueOrThrow({ where: { id: saved.id } });

    await t.test("settings.write and the selected tenant/salon remain mandatory", async () => {
      const payload = { receiptIssuerName: "変更禁止", invoiceRegistrationNumber: "T1234567890123" };
      assert.equal((await patch(payload, {})).statusCode, 401);
      for (const headers of [reader, cashWriter, { ...writer, "x-salon-id": otherSalon.id }, { ...writer, "x-salon-id": foreignSalon.id }, { ...writer, "x-tenant-slug": foreignTenant.slug }]) {
        assert.equal((await patch(payload, headers)).statusCode, 403);
      }
      const current = await stored();
      assert.equal(current.receiptIssuerName, null); assert.equal(current.invoiceRegistrationNumber, null);
      const initial = await read(); assert.equal(initial.statusCode, 200, initial.body);
      assert.equal(initial.json().settings.receiptIssuerName, null); assert.equal(initial.json().settings.invoiceRegistrationNumber, null);
    });

    await t.test("normalized issuer settings and unrelated partial updates preserve each other", async () => {
      const written = await patch({ receiptIssuerName: " 株式会社 テスト ", invoiceRegistrationNumber: " t1234567890123 " });
      assert.equal(written.statusCode, 200, written.body);
      assert.equal(written.json().settings.receiptIssuerName, "株式会社 テスト");
      assert.equal(written.json().settings.invoiceRegistrationNumber, "T1234567890123");
      assert.equal((await patch({ openTime: "10:00" })).statusCode, 200);
      assert.equal((await patch({ receiptIssuerName: "更新した正式事業者名" })).statusCode, 200);
      const current = await stored();
      assert.equal(current.receiptIssuerName, "更新した正式事業者名"); assert.equal(current.invoiceRegistrationNumber, "T1234567890123");
      assert.equal(current.openTime, "10:00"); assert.equal(current.closeTime, "20:00");
      assert.equal(current.notificationEmail, "existing@example.test"); assert.equal(current.friendMessage, "元の登録案内");
      assert.equal(current.storeId, "immutable-store");
      const response = await read(); assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().settings.invoiceRegistrationNumber, current.invoiceRegistrationNumber);
      assert.equal(response.json().salon.name, "表示用店舗名");
    });

    await t.test("invalid values and immutable store ID errors write no changes", async () => {
      const before = await stored();
      for (const payload of [
        { receiptIssuerName: "改行\n事業者" }, { receiptIssuerName: "a".repeat(301) },
        { receiptIssuerName: "変更禁止", invoiceRegistrationNumber: "1234567890123" },
        { invoiceRegistrationNumber: "T12345678901234" }, { invoiceRegistrationNumber: "T１２３４５６７８９０１２３" },
        { invoiceRegistrationNumber: "T1234567890123\n追加" }
      ]) {
        const response = await patch(payload); assert.equal(response.statusCode, 400, response.body);
      }
      const conflict = await patch({ storeId: "changed-store", invoiceRegistrationNumber: "T9999999999999" });
      assert.equal(conflict.statusCode, 409, conflict.body);
      const after = await stored();
      assert.equal(after.receiptIssuerName, before.receiptIssuerName); assert.equal(after.invoiceRegistrationNumber, before.invoiceRegistrationNumber);
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
    });

    await t.test("explicit nulls or blank strings clear only their own field", async () => {
      assert.equal((await patch({ receiptIssuerName: "a".repeat(300) })).statusCode, 200);
      assert.equal((await stored()).receiptIssuerName?.length, 300);
      assert.equal((await patch({ invoiceRegistrationNumber: "   " })).statusCode, 200);
      assert.equal((await stored()).invoiceRegistrationNumber, null);
      assert.equal((await stored()).receiptIssuerName?.length, 300);
      assert.equal((await patch({ receiptIssuerName: null })).statusCode, 200);
      const final = (await read()).json().settings;
      assert.equal(final.receiptIssuerName, null); assert.equal(final.invoiceRegistrationNumber, null);
      assert.equal(final.notificationEmail, "existing@example.test"); assert.equal(final.openTime, "10:00");
    });
  } finally {
    await server.close(); auth.mock.restore();
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
