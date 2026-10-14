import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { hasPermission } from "../src/permissions.js";
import type { OperationContext } from "../src/operations-support.js";
import { staffNaturalKey, staffPublicationKey } from "../src/staff-import.js";

const testDatabaseUrl = process.env.STAFF_IMPORT_TEST_DATABASE_URL;
test("staff import validates, scopes, rolls back and safely retries without creating accounts", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  const [{ prisma }, { registerStaffImportRoutes }] = await Promise.all([import("../src/database.js"), import("../src/staff-import-routes.js")]);
  const server = Fastify();
  const marker = randomUUID().replaceAll("-", "").slice(0, 8);
  const tenantIds: string[] = []; const userIds: string[] = [];
  const contexts: Record<string, OperationContext> = {};
  const root = "/api/admin/staff-imports/salonboard";
  try {
    const tenant = await prisma.tenant.create({ data: { slug: "missmrs-takamatsu", name: "Synthetic staff import" } }); tenantIds.push(tenant.id);
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic salon A" } });
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic salon B" } });
    const foreignTenant = await prisma.tenant.create({ data: { slug: `staff-import-foreign-${marker}`, name: "Synthetic foreign" } }); tenantIds.push(foreignTenant.id);
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "Synthetic foreign salon" } });
    async function account(key: string, permissions: string[], selectedTenant = tenant, selectedSalon = salon) {
      const user = await prisma.appUser.create({ data: { firebaseUid: `staff-import-${key}-${marker}`, displayName: "Synthetic actor" } }); userIds.push(user.id);
      const membership = await prisma.tenantMembership.create({ data: { tenantId: selectedTenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions, salonIds: [selectedSalon.id] } });
      contexts[key] = { tenant: selectedTenant, salon: selectedSalon, user, membership };
    }
    await account("writer", ["master.write"]);
    await account("reader", ["master.read"]);
    await account("none", []);
    await account("other", ["master.read", "master.write"], tenant, otherSalon);
    await account("foreign", ["master.read", "master.write"], foreignTenant, foreignSalon);
    await registerStaffImportRoutes(server, { requireContext: async (request, reply, permission) => {
      const context = contexts[String(request.headers["x-test-context"] ?? "")];
      if (!context) { reply.code(401).send({ message: "Authentication required" }); return null; }
      if (!hasPermission(context, permission)) { reply.code(403).send({ message: "Permission denied" }); return null; }
      // Keep an initial snapshot: mutations must re-read permissions inside lockOperation.
      return { ...context, tenant: { ...context.tenant }, salon: { ...context.salon }, user: { ...context.user }, membership: { ...context.membership } };
    } });
    const records = [
      { name: "SYNTHETIC SAME NAME", kana: "SYNTHETIC ONE", role: "ESTHETICIAN", active: true, parallelCapacity: 2 },
      { name: "SYNTHETIC SAME NAME", kana: "SYNTHETIC TWO", role: "ESTHETICIAN", active: true, parallelCapacity: 3 },
      { name: "SYNTHETIC ROOM", kana: "", role: "ROOM_RESOURCE", active: false, parallelCapacity: 1 }
    ].map((value, index) => ({ ...value, externalRecordKey: staffNaturalKey("H000551123", value.name, value.kana),
      allocationOrder: index + 1, sortOrder: index + 1,
      profile: { description: `SYNTHETIC-PRIVATE-PROFILE-${index}`, optionalFields: { years: index + 2 }, correspondingMenus: ["Synthetic treatment"] }
    }));
    const envelope = { version: 1, source: "SALONBOARD", sourceStoreId: "H000551123", expectedCount: records.length, capturedAt: "2026-10-14T01:00:00Z", records };
    const call = (method: "GET" | "POST", url: string, payload?: unknown, key = "writer") => server.inject({ method, url, headers: { "x-test-context": key }, payload });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    const otherScope = { tenantId: tenant.id, salonId: otherSalon.id };
    const initialUsers = await prisma.appUser.count(); const initialMemberships = await prisma.tenantMembership.count();

    await t.test("authentication, write permissions, source/target binding and complete batch validation reject before writes", async () => {
      assert.equal((await call("POST", root, envelope, "missing")).statusCode, 401);
      for (const key of ["reader", "none", "foreign"]) assert.equal((await call("POST", root, envelope, key)).statusCode, 403);
      for (const invalid of [
        { ...envelope, expectedCount: 4 }, { ...envelope, records: [...records.slice(0, 2), records[0]] },
        { ...envelope, records: [...records.slice(0, 2), { ...records[2], active: true }] },
        { ...envelope, records: [...records.slice(0, 2), { ...records[2], name: "" }] },
        { ...envelope, records: [...records.slice(0, 2), { ...records[2], externalRecordKey: "a".repeat(64) }] },
        { ...envelope, sourceStoreId: "H000999999" }, { ...envelope, unexpected: true }
      ]) assert.equal((await call("POST", root, invalid)).statusCode, 400);
      assert.equal(await prisma.staff.count({ where: scope }), 0);
      assert.equal(await prisma.staffExternalRecord.count({ where: scope }), 0);
      assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id } }), 0);
    });

    await t.test("a later database rejection rolls back staff, mappings and audit together", async () => {
      const constraint = `staff_import_rollback_${marker}`;
      await prisma.$executeRawUnsafe(`ALTER TABLE "Staff" ADD CONSTRAINT "${constraint}" CHECK (name <> 'SYNTHETIC ROOM')`);
      try {
        const failed = await call("POST", root, envelope);
        assert.equal(failed.statusCode, 500, failed.body);
        assert(!failed.body.includes("SYNTHETIC ROOM")); assert(!failed.body.includes("SYNTHETIC-PRIVATE-PROFILE"));
        assert.equal(await prisma.staff.count({ where: scope }), 0);
        assert.equal(await prisma.staffExternalRecord.count({ where: scope }), 0);
        assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id } }), 0);
      } finally { await prisma.$executeRawUnsafe(`ALTER TABLE "Staff" DROP CONSTRAINT "${constraint}"`); }
    });

    let firstId = ""; let dummyId = "";
    await t.test("concurrent retries create one mapping per snapshot key and do not merge an unmapped matching name", async () => {
      const dummy = await prisma.staff.create({ data: { ...scope, name: records[0].name, kana: records[0].kana, role: "ESTHETICIAN", color: "#123456", sortOrder: 50, comment: "SYNTHETIC DUMMY" } }); dummyId = dummy.id;
      const results = await Promise.all([0, 1].map(() => call("POST", root, envelope)));
      for (const response of results) {
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().expectedCount, 3); assert.match(response.json().checksum, /^[0-9a-f]{64}$/);
        assert(!response.body.includes(records[0].name)); assert(!response.body.includes("SYNTHETIC-PRIVATE-PROFILE"));
        assert.equal(response.headers["cache-control"], "private, no-store");
      }
      assert.deepEqual(results.map((response) => response.json().createdCount).sort(), [0, 3]);
      assert.deepEqual(results.map((response) => response.json().skippedCount).sort(), [0, 3]);
      assert.equal(await prisma.staff.count({ where: scope }), 4); assert.equal(await prisma.staffExternalRecord.count({ where: scope }), 3);
      assert.equal(await prisma.appUser.count(), initialUsers); assert.equal(await prisma.tenantMembership.count(), initialMemberships);
      const imported = await prisma.staffExternalRecord.findMany({ where: scope, include: { staff: true } });
      assert.equal(new Set(imported.map((value) => value.staffId)).size, 3);
      assert(!imported.some((value) => value.staffId === dummy.id));
      firstId = imported.find((value) => value.externalRecordKey === records[0].externalRecordKey)!.staffId;
      assert.equal(imported.find((value) => value.staff.role === "ROOM_RESOURCE")!.staff.active, false);
      assert.equal(imported.find((value) => value.externalRecordKey === records[1].externalRecordKey)!.staff.parallelCapacity, 3);
      assert.equal(imported.find((value) => value.externalRecordKey === records[0].externalRecordKey)!.staff.nominationFee, 0);
      assert.equal((imported.find((value) => value.externalRecordKey === records[0].externalRecordKey)!.profile as { unconfirmedDefaults: { nominationFee: number } }).unconfirmedDefaults.nominationFee, 0);
      assert.equal((await prisma.staff.findUniqueOrThrow({ where: { id: dummy.id } })).comment, "SYNTHETIC DUMMY");
      const audit = await prisma.auditLog.findMany({ where: { tenantId: tenant.id } });
      assert.equal(audit.length, 2);
      assert(!JSON.stringify(audit).includes("SYNTHETIC SAME NAME")); assert(!JSON.stringify(audit).includes("SYNTHETIC-PRIVATE-PROFILE"));
    });

    await t.test("another capture preserves manual edits and retained source profiles", async () => {
      await prisma.staff.update({ where: { id: firstId }, data: { name: "SYNTHETIC MANUAL EDIT", kana: "SYNTHETIC MANUAL KANA", role: "MANAGER", active: false, parallelCapacity: 4, sortOrder: 99, comment: "SYNTHETIC MANUAL COMMENT" } });
      const later = await call("POST", root, { ...envelope, capturedAt: "2026-10-14T02:00:00Z", records: records.map((record) => ({ ...record, profile: { description: "SYNTHETIC CHANGED PROFILE" } })) });
      assert.equal(later.statusCode, 200, later.body); assert.equal(later.json().createdCount, 0); assert.equal(later.json().skippedCount, 3);
      const updated = await prisma.staff.findUniqueOrThrow({ where: { id: firstId } });
      assert.equal(updated.name, "SYNTHETIC MANUAL EDIT"); assert.equal(updated.kana, "SYNTHETIC MANUAL KANA");
      assert.equal(updated.role, "MANAGER"); assert.equal(updated.active, false); assert.equal(updated.parallelCapacity, 4);
      assert.equal(updated.sortOrder, 99); assert.equal(updated.comment, "SYNTHETIC MANUAL COMMENT");
      const retained = await prisma.staffExternalRecord.findFirstOrThrow({ where: { ...scope, staffId: firstId } });
      assert(JSON.stringify(retained.profile).includes("SYNTHETIC-PRIVATE-PROFILE-0")); assert(!JSON.stringify(retained.profile).includes("SYNTHETIC CHANGED PROFILE"));
      assert.equal(await prisma.staff.count({ where: scope }), 4);
    });

    await t.test("detail and next sort use bounded scoped queries and independent read/write permissions", async () => {
      const detail = await call("GET", `/api/admin/staff/${firstId}`, undefined, "reader");
      assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().id, firstId);
      assert.equal(detail.json().sourceRecords.length, 1); assert.equal(detail.json().sourceRecords[0].sourceStoreId, "H000551123");
      assert.equal(detail.json().sourceRecords[0].profile.identityKind, "SOURCE_NAME_KANA_SNAPSHOT");
      assert.deepEqual(detail.json().sourceRecords[0].profile.sourceProfile, records[0].profile);
      assert.equal("externalRecordKey" in detail.json().sourceRecords[0], false);
      assert.equal((await call("GET", `/api/admin/staff/${dummyId}`, undefined, "reader")).json().sourceRecords.length, 0);
      assert.equal((await call("GET", `/api/admin/staff/${firstId}`, undefined, "writer")).statusCode, 200, "Master editing also grants master reading under the existing access policy");
      assert.equal((await call("GET", `/api/admin/staff/${firstId}`, undefined, "none")).statusCode, 403);
      assert.equal((await call("GET", `/api/admin/staff/${firstId}`, undefined, "other")).statusCode, 404);
      assert.equal((await call("GET", `/api/admin/staff/${firstId}`, undefined, "foreign")).statusCode, 404);
      assert.equal((await call("GET", `/api/admin/staff/${"a".repeat(161)}`, undefined, "reader")).statusCode, 414, "Fastify rejects oversized route parameters before the handler");
      assert.equal((await call("GET", "/api/admin/staff/next-sort", undefined, "missing")).statusCode, 401);
      assert.equal((await call("GET", "/api/admin/staff/next-sort", undefined, "reader")).statusCode, 403);
      assert.equal((await call("GET", "/api/admin/staff/next-sort")).json().sortOrder, 100);
      assert.equal((await call("GET", "/api/admin/staff/next-sort", undefined, "other")).json().sortOrder, 0);
      await prisma.staff.create({ data: { tenantId: foreignTenant.id, salonId: foreignSalon.id, name: "SYNTHETIC FOREIGN", kana: "", role: "ESTHETICIAN", color: "#123456", sortOrder: 9999 } });
      assert.equal((await call("GET", "/api/admin/staff/next-sort")).json().sortOrder, 100);
    });

    await t.test("identical source keys remain independent across salon boundaries and foreign staff FKs are rejected", async () => {
      const other = await call("POST", root, envelope, "other");
      assert.equal(other.statusCode, 200, other.body); assert.equal(other.json().createdCount, 3);
      assert.equal(await prisma.staff.count({ where: otherScope }), 3);
      assert.equal(await prisma.staffExternalRecord.count({ where: otherScope }), 3);
      await assert.rejects(() => prisma.staffExternalRecord.create({ data: { ...otherScope, staffId: firstId, source: "SALONBOARD", sourceStoreId: "H000551123", externalRecordKey: "a".repeat(64), profile: {} } }));
      assert.equal(await prisma.staffExternalRecord.count({ where: otherScope }), 3);
    });

    await t.test("a stable publication ID skips renamed source records and keeps manual fields and original source metadata", async () => {
      const publicationStaffId = "SYNTHETIC-PUBLICATION-001";
      const published = { ...records[0], name: "SYNTHETIC PUBLISHED NAME", kana: "SYNTHETIC PUBLISHED KANA", publicationStaffId,
        externalRecordKey: staffPublicationKey("H000551123", publicationStaffId), nominationFee: 500, comment: "SYNTHETIC SOURCE COMMENT" };
      const publishedEnvelope = { ...envelope, expectedCount: 1, records: [published] };
      const created = await call("POST", root, publishedEnvelope, "other");
      assert.equal(created.statusCode, 200, created.body); assert.equal(created.json().createdCount, 1); assert.equal(created.json().skippedCount, 0);
      const mapping = await prisma.staffExternalRecord.findFirstOrThrow({ where: { ...otherScope, externalRecordKey: published.externalRecordKey } });
      const imported = await prisma.staff.findUniqueOrThrow({ where: { id: mapping.staffId } });
      assert.equal(imported.nominationFee, 500); assert.equal(imported.comment, "SYNTHETIC SOURCE COMMENT");
      const detail = await call("GET", `/api/admin/staff/${mapping.staffId}`, undefined, "other");
      assert.equal(detail.statusCode, 200); assert.equal(detail.json().sourceRecords[0].profile.identityKind, "SOURCE_PUBLICATION_STAFF_ID");
      assert.equal(detail.json().sourceRecords[0].profile.publicationStaffId, publicationStaffId);
      await prisma.staff.update({ where: { id: mapping.staffId }, data: { name: "SYNTHETIC MANUAL PUBLISHED NAME", kana: "SYNTHETIC MANUAL PUBLISHED KANA", nominationFee: 750, comment: "SYNTHETIC MANUAL PUBLISHED COMMENT", active: false } });
      const changedSource = { ...publishedEnvelope, capturedAt: "2026-10-14T02:00:00Z", records: [{ ...published, name: "SYNTHETIC RENAMED SOURCE", kana: "SYNTHETIC RENAMED KANA", nominationFee: 900, comment: "SYNTHETIC RENAMED COMMENT" }] };
      const repeated = await call("POST", root, changedSource, "other");
      assert.equal(repeated.statusCode, 200, repeated.body); assert.equal(repeated.json().createdCount, 0); assert.equal(repeated.json().skippedCount, 1);
      const preserved = await prisma.staff.findUniqueOrThrow({ where: { id: mapping.staffId } });
      assert.equal(preserved.name, "SYNTHETIC MANUAL PUBLISHED NAME"); assert.equal(preserved.kana, "SYNTHETIC MANUAL PUBLISHED KANA");
      assert.equal(preserved.nominationFee, 750); assert.equal(preserved.comment, "SYNTHETIC MANUAL PUBLISHED COMMENT"); assert.equal(preserved.active, false);
      const retained = await prisma.staffExternalRecord.findUniqueOrThrow({ where: { id: mapping.id } });
      assert.equal((retained.profile as { name: string }).name, "SYNTHETIC PUBLISHED NAME");
      assert.equal(await prisma.staff.count({ where: otherScope }), 4); assert.equal(await prisma.staffExternalRecord.count({ where: otherScope }), 4);
      assert.equal(await prisma.appUser.count(), initialUsers); assert.equal(await prisma.tenantMembership.count(), initialMemberships);
    });

    await t.test("target identity is rechecked after a stale context is refreshed inside the transaction", async () => {
      await prisma.tenant.update({ where: { id: tenant.id }, data: { slug: `staff-import-renamed-${marker}` } });
      try {
        const rejected = await call("POST", root, { ...envelope, capturedAt: "2026-10-14T03:00:00Z" });
        assert.equal(rejected.statusCode, 403, rejected.body);
        assert.equal(await prisma.staff.count({ where: scope }), 4); assert.equal(await prisma.staffExternalRecord.count({ where: scope }), 3);
      } finally { await prisma.tenant.update({ where: { id: tenant.id }, data: { slug: "missmrs-takamatsu" } }); }
    });

    await t.test("revoked authority and disabled actors are re-read inside the write transaction", async () => {
      await prisma.tenantMembership.update({ where: { tenantId_userId: { tenantId: tenant.id, userId: contexts.writer.user.id } }, data: { permissions: [] } });
      const rejected = await call("POST", root, { ...envelope, capturedAt: "2026-10-14T03:00:00Z" });
      assert.equal(rejected.statusCode, 403, rejected.body);
      await prisma.tenantMembership.update({ where: { tenantId_userId: { tenantId: tenant.id, userId: contexts.writer.user.id } }, data: { permissions: ["master.write"] } });
      await prisma.appUser.update({ where: { id: contexts.writer.user.id }, data: { disabled: true } });
      assert.equal((await call("POST", root, envelope)).statusCode, 403);
      assert.equal(await prisma.staff.count({ where: scope }), 4); assert.equal(await prisma.staffExternalRecord.count({ where: scope }), 3);
      assert.equal(await prisma.appUser.count(), initialUsers); assert.equal(await prisma.tenantMembership.count(), initialMemberships);
    });
  } finally {
    await server.close();
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
