import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { hasPermission } from "../src/permissions.js";
import type { OperationContext } from "../src/operations-support.js";

const testDatabaseUrl = process.env.CUSTOMER_IMPORT_TEST_DATABASE_URL;
test("prepared manifests, scoped imports, chunk rollback and safe retries", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  const [{ prisma }, { registerCustomerImportRoutes }] = await Promise.all([import("../src/database.js"), import("../src/customer-import-routes.js")]);
  const server = Fastify();
  const marker = randomUUID().slice(0, 8);
  const tenantIds: string[] = []; const userIds: string[] = [];
  const contexts: Record<string, OperationContext> = {};
  const root = "/api/admin/customer-imports/salonboard";
  try {
    const tenant = await prisma.tenant.create({ data: { slug: "missmrs-takamatsu", name: "Synthetic import test" } }); tenantIds.push(tenant.id);
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic salon A" } });
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic salon B" } });
    const foreignTenant = await prisma.tenant.create({ data: { slug: `import-foreign-${marker}`, name: "Synthetic foreign" } }); tenantIds.push(foreignTenant.id);
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "Foreign" } });
    async function account(key: string, permissions: string[], selectedTenant = tenant, selectedSalon = salon) {
      const user = await prisma.appUser.create({ data: { firebaseUid: `import-${key}-${marker}`, displayName: "Synthetic actor" } }); userIds.push(user.id);
      const membership = await prisma.tenantMembership.create({ data: { tenantId: selectedTenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions, salonIds: [selectedSalon.id] } });
      contexts[key] = { tenant: selectedTenant, salon: selectedSalon, user, membership };
    }
    await account("writer", ["customer.write", "chart.write"]);
    await account("reader", ["customer.read"]);
    await account("no-chart", ["customer.write"]);
    await account("other", ["customer.write", "chart.write"], tenant, otherSalon);
    await account("foreign", ["customer.write", "chart.write"], foreignTenant, foreignSalon);
    await registerCustomerImportRoutes(server, { requireContext: async (request, reply, permission) => {
      const context = contexts[String(request.headers["x-test-context"] ?? "")];
      if (!context) { reply.code(401).send({ message: "Authentication required" }); return null; }
      if (!hasPermission(context, permission)) { reply.code(403).send({ message: "Permission denied" }); return null; }
      return { ...context, tenant: { ...context.tenant }, salon: { ...context.salon }, user: { ...context.user }, membership: { ...context.membership } };
    } });
    const records = Array.from({ length: 55 }, (_, index) => ({
      externalCustomerId: `C014${String(index).padStart(9, "0")}`, name: `ImportRow ${String(index).padStart(3, "0")}`, kana: `Synthetic ${index}`,
      customerNumber: "SHARED-EDITABLE-NUMBER", phone: "090-1111-2222", gender: "Synthetic", occupation: "Synthetic",
      sourceVisitCount: 12, sourceLastVisitDate: "2026/10/13", profile: { "お客様メモ": `PRIVATE-SYNTHETIC-NOTE-${index}`, "E-MAIL (PC)": `synthetic${index}@example.test` }
    }));
    const envelope = { version: 1, source: "SALONBOARD", sourceStoreId: "H000551123", expectedCount: 55, capturedAt: "2026-10-14T00:00:00Z", records };
    const call = (method: "GET" | "POST", url: string, payload?: unknown, key = "writer") => server.inject({ method, url, headers: { "x-test-context": key }, payload });
    const scope = { tenantId: tenant.id, salonId: salon.id };

    await t.test("authentication, dual permissions, store binding and whole-file validation reject before writes", async () => {
      assert.equal((await call("POST", `${root}/prepare`, envelope, "missing")).statusCode, 401);
      for (const key of ["reader", "no-chart", "foreign"]) assert.equal((await call("POST", `${root}/prepare`, envelope, key)).statusCode, 403);
      for (const invalid of [
        { ...envelope, expectedCount: 56 }, { ...envelope, records: [...records.slice(0, 54), records[0]] },
        { ...envelope, records: [...records.slice(0, 54), { ...records[54], name: "" }] }, { ...envelope, sourceStoreId: "H000999999" }
      ]) assert.equal((await call("POST", `${root}/prepare`, invalid)).statusCode, 400);
      assert.equal(await prisma.customer.count({ where: scope }), 0); assert.equal(await prisma.customerImportRun.count(), 0);
    });
    let id = "";
    await t.test("prepare stores hashes only and resume uses the same manifest", async () => {
      const prepared = await call("POST", `${root}/prepare`, envelope); assert.equal(prepared.statusCode, 200, prepared.body);
      id = prepared.json().id;
      assert.equal(prepared.json().processedCount, 0); assert.equal(prepared.json().expectedCount, 55); assert.equal(prepared.json().chunkSize, 50);
      assert(!prepared.body.includes("PRIVATE-SYNTHETIC")); assert(!prepared.body.includes("ImportRow")); assert(!prepared.body.includes("recordHashes"));
      const stored = await prisma.customerImportRun.findUniqueOrThrow({ where: { id } });
      assert.equal(stored.recordHashes.length, 55); assert(stored.recordHashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
      assert.equal((await call("POST", `${root}/prepare`, envelope)).json().id, id);
      assert.equal((await call("GET", `${root}/${id}`, undefined, "other")).statusCode, 404);
      assert.equal((await call("GET", `${root}/${id}`, undefined, "foreign")).statusCode, 403);
      assert.equal((await call("GET", `${root}/${id}`, undefined, "reader")).statusCode, 200);
    });
    await t.test("changed data and wrong chunks fail, and a mid-chunk DB failure rolls back every row", async () => {
      const changed = records.slice(0, 50).map((record) => ({ ...record })); changed[2].name = "Changed";
      for (const payload of [{ offset: 0, records: changed }, { offset: 0, records: records.slice(0, 49) }, { offset: 1, records: records.slice(0, 50) }, { offset: 100, records: [records[0]] }]) {
        assert.equal((await call("POST", `${root}/${id}/chunks`, payload)).statusCode, 400);
      }
      await prisma.$executeRawUnsafe('ALTER TABLE "Customer" ADD CONSTRAINT customer_import_rollback_test CHECK (name <> \'ImportRow 002\')');
      try {
        const failed = await call("POST", `${root}/${id}/chunks`, { offset: 0, records: records.slice(0, 50) });
        assert.equal(failed.statusCode, 500, failed.body); assert(!failed.body.includes("ImportRow"));
        assert.equal(await prisma.customer.count({ where: scope }), 0); assert.equal(await prisma.customerExternalRecord.count(), 0);
        assert.deepEqual((await prisma.customerImportRun.findUniqueOrThrow({ where: { id } })).processedOffsets, []);
      } finally { await prisma.$executeRawUnsafe('ALTER TABLE "Customer" DROP CONSTRAINT customer_import_rollback_test'); }
    });
    await t.test("out-of-order chunks and concurrent retry create exactly one customer per stable source ID", async () => {
      const last = await call("POST", `${root}/${id}/chunks`, { offset: 50, records: records.slice(50) });
      assert.equal(last.statusCode, 200, last.body); assert.equal(last.json().createdCount, 5);
      const results = await Promise.all([0, 1].map(() => call("POST", `${root}/${id}/chunks`, { offset: 0, records: records.slice(0, 50) })));
      for (const response of results) assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(results.map((response) => response.json().chunk.alreadyProcessed).sort(), [false, true]);
      assert.equal(await prisma.customer.count({ where: scope }), 55); assert.equal(await prisma.customerExternalRecord.count({ where: scope }), 55);
      const status = (await call("GET", `${root}/${id}`)).json(); assert.equal(status.completed, true); assert.equal(status.createdCount, 55); assert.equal(status.skippedCount, 0);
      const customer = await prisma.customer.findFirstOrThrow({ where: scope });
      assert.equal(customer.visitCount, 0); assert.equal(customer.totalSpent, 0); assert.equal(customer.lastVisitAt, null); assert.equal(customer.memo, null);
      const audits = await prisma.auditLog.findMany({ where: { tenantId: tenant.id } });
      assert(!JSON.stringify(audits).includes("PRIVATE-SYNTHETIC")); assert(!JSON.stringify(audits).includes("ImportRow"));
    });
    await t.test("new capture skips existing mappings and preserves subsequent manual edits", async () => {
      const first = await prisma.customerExternalRecord.findFirstOrThrow({ where: { ...scope, externalCustomerId: records[0].externalCustomerId } });
      await prisma.customer.update({ where: { id: first.customerId }, data: { name: "Manually Edited", memo: "MANUAL CLINICAL TEST NOTE", phone: "070-3333-4444" } });
      const newRun = (await call("POST", `${root}/prepare`, { ...envelope, capturedAt: "2026-10-14T01:00:00Z" })).json();
      assert.notEqual(newRun.id, id);
      await call("POST", `${root}/${newRun.id}/chunks`, { offset: 0, records: records.slice(0, 50) });
      const finished = await call("POST", `${root}/${newRun.id}/chunks`, { offset: 50, records: records.slice(50) });
      assert.equal(finished.statusCode, 200, finished.body); assert.equal(finished.json().createdCount, 0); assert.equal(finished.json().skippedCount, 55);
      const edited = await prisma.customer.findUniqueOrThrow({ where: { id: first.customerId } });
      assert.equal(edited.name, "Manually Edited"); assert.equal(edited.memo, "MANUAL CLINICAL TEST NOTE"); assert.equal(edited.phone, "070-3333-4444");
      assert.equal(await prisma.customer.count({ where: scope }), 55);
      // Same source keys in another salon stay independent and cannot cross-link.
      const otherRun = (await call("POST", `${root}/prepare`, envelope, "other")).json();
      const otherChunk = await call("POST", `${root}/${otherRun.id}/chunks`, { offset: 50, records: records.slice(50) }, "other");
      assert.equal(otherChunk.statusCode, 200); assert.equal(otherChunk.json().createdCount, 5);
    });
    await t.test("authority is rechecked after permission revocation before writes", async () => {
      await prisma.tenantMembership.update({ where: { tenantId_userId: { tenantId: tenant.id, userId: contexts.writer.user.id } }, data: { permissions: ["customer.write"] } });
      const rejected = await call("POST", `${root}/prepare`, { ...envelope, capturedAt: "2026-10-14T03:00:00Z" });
      assert.equal(rejected.statusCode, 403, rejected.body);
    });
  } finally {
    await server.close();
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
