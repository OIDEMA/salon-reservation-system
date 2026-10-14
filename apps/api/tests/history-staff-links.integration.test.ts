import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { hasPermission } from "../src/permissions.js";
import type { OperationContext } from "../src/operations-support.js";
import { staffPublicationKey } from "../src/staff-import.js";

const testDatabaseUrl = process.env.HISTORY_STAFF_LINK_TEST_DATABASE_URL;
test("historical staff links are atomic, scoped, repeatable and isolated from operational records", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  const [{ prisma }, { registerHistoryStaffLinkRoutes, historyStaffSnapshotKey }] = await Promise.all([
    import("../src/database.js"), import("../src/history-staff-links.js")
  ]);
  const server = Fastify();
  const marker = randomUUID().replaceAll("-", "").slice(0, 8);
  const tenantIds: string[] = []; const userIds: string[] = [];
  const contexts: Record<string, OperationContext> = {};
  const root = "/api/admin/history-staff-links";
  const permissions = ["master.write", "reservation.write", "chart.write"];
  const sourceStoreId = "H000551123";
  const publicationId = "SYNTHETIC-CURRENT-PUBLICATION";
  const legacyNames = ["SYNTHETIC LEGACY A", "SYNTHETIC LEGACY B"];
  // A fixed identifier allowlist ensures no SQL identifier is derived from input.
  const untouchedTables = ["Tenant", "Salon", "AppUser", "TenantMembership", "TenantInvitation", "Customer", "CustomerExternalRecord", "CustomerImportRun", "HistoricalReservationImportRun", "Service", "MenuCategory", "Equipment", "SalonSettings", "Reservation", "Shift", "Notification", "CashCheckout", "CashCheckoutItem", "CashPaymentAllocation", "CashRegisterSession", "CashRegisterMovement", "TreatmentChart", "TreatmentChartRevision", "TreatmentChartPhoto", "TreatmentChartRevisionPhoto"];
  try {
    const tenant = await prisma.tenant.create({ data: { slug: "missmrs-takamatsu", name: "Synthetic historical staff links" } }); tenantIds.push(tenant.id);
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic salon A" } });
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic salon B" } });
    const foreignTenant = await prisma.tenant.create({ data: { slug: `history-staff-foreign-${marker}`, name: "Synthetic foreign tenant" } }); tenantIds.push(foreignTenant.id);
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "Synthetic foreign salon" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    const otherScope = { tenantId: tenant.id, salonId: otherSalon.id };
    const foreignScope = { tenantId: foreignTenant.id, salonId: foreignSalon.id };
    async function account(key: string, selectedPermissions: string[], selectedTenant = tenant, selectedSalon = salon) {
      const user = await prisma.appUser.create({ data: { firebaseUid: `history-staff-${key}-${marker}`, displayName: "Synthetic actor" } }); userIds.push(user.id);
      const membership = await prisma.tenantMembership.create({ data: { tenantId: selectedTenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions: selectedPermissions, salonIds: [selectedSalon.id] } });
      contexts[key] = { tenant: selectedTenant, salon: selectedSalon, user, membership };
    }
    await account("writer", permissions);
    for (const missing of permissions) await account(`missing-${missing}`, permissions.filter((permission) => permission !== missing));
    await account("reader", ["master.read", "reservation.read", "chart.read"]);
    await account("none", []);
    await account("foreign", permissions, foreignTenant, foreignSalon);
    await registerHistoryStaffLinkRoutes(server, { requireContext: async (request, reply, permission) => {
      const context = contexts[String(request.headers["x-test-context"] ?? "")];
      if (!context) { reply.code(401).send({ message: "Authentication required" }); return null; }
      if (!hasPermission(context, permission)) { reply.code(403).send({ message: "Permission denied" }); return null; }
      // Intentionally stale: mutation authority must be refreshed inside the transaction.
      return { ...context, tenant: { ...context.tenant }, salon: { ...context.salon }, user: { ...context.user }, membership: { ...context.membership } };
    } });
    const call = (suffix: "prepare" | "apply", payload: unknown = {}, key = "writer") => server.inject({ method: "POST", url: `${root}/${suffix}`, headers: { "x-test-context": key }, payload });
    const prepared = async () => {
      const response = await call("prepare");
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().ready, true, response.body);
      assert.match(response.json().checksum, /^[0-9a-f]{64}$/);
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert(!response.body.includes("PRIVATE-SYNTHETIC-CUSTOMER"));
      assert(!response.body.includes("PRIVATE-SYNTHETIC-CLINICAL"));
      return response.json() as { ready: boolean; checksum: string };
    };
    const current = await prisma.staff.create({ data: { ...scope, name: "SYNTHETIC MANUALLY RENAMED CURRENT", kana: "SYNTHETIC KANA", role: "MANAGER", color: "#123456", active: true, parallelCapacity: 4, nominationFee: 777, comment: "SYNTHETIC CURRENT MANUAL COMMENT", sortOrder: 25 } });
    const alternate = await prisma.staff.create({ data: { ...scope, name: "SYNTHETIC ALTERNATE CURRENT", kana: "", role: "ESTHETICIAN", color: "#654321", active: false } });
    const otherStaff = await prisma.staff.create({ data: { ...otherScope, name: "SYNTHETIC OTHER SALON", kana: "", role: "ESTHETICIAN", color: "#123456" } });
    const foreignStaff = await prisma.staff.create({ data: { ...foreignScope, name: "SYNTHETIC FOREIGN STAFF", kana: "", role: "ESTHETICIAN", color: "#123456" } });
    const publicationKey = staffPublicationKey(sourceStoreId, publicationId);
    const currentMapping = await prisma.staffExternalRecord.create({ data: { ...scope, staffId: current.id, source: "SALONBOARD", sourceStoreId, externalRecordKey: publicationKey, profile: { publicationStaffId: publicationId, identityKind: "SOURCE_PUBLICATION_STAFF_ID", sourceProfile: { comment: "SYNTHETIC CURRENT SOURCE PROFILE" } } } });
    await prisma.staffExternalRecord.create({ data: { ...otherScope, staffId: otherStaff.id, source: "SALONBOARD", sourceStoreId, externalRecordKey: publicationKey, profile: {} } });
    await prisma.staffExternalRecord.create({ data: { ...foreignScope, staffId: foreignStaff.id, source: "SALONBOARD", sourceStoreId, externalRecordKey: publicationKey, profile: {} } });
    const customer = await prisma.customer.create({ data: { ...scope, name: "Synthetic existing customer", kana: "SYNTHETIC", visitCount: 12, totalSpent: 54321, lastVisitAt: new Date("2026-01-01T00:00:00Z"), memo: "PRIVATE-SYNTHETIC-CLINICAL MASTER NOTE" } });
    const service = await prisma.service.create({ data: { ...scope, name: "Synthetic operational service", category: "Synthetic", durationMinutes: 15, price: 7654, color: "#123456", active: false } });
    const reservation = await prisma.reservation.create({ data: { ...scope, customerId: customer.id, staffId: current.id, serviceId: service.id, startsAt: new Date("2026-06-01T01:00:00Z"), endsAt: new Date("2026-06-01T01:15:00Z"), status: "COMPLETED", paymentStatus: "PAID", memo: "SYNTHETIC OPERATIONAL NOTE" } });
    await prisma.shift.create({ data: { ...scope, staffId: current.id, label: "Synthetic operational shift", type: "AVAILABLE", startsAt: reservation.startsAt, endsAt: reservation.endsAt } });
    await prisma.notification.create({ data: { ...scope, kind: "Synthetic", title: "Synthetic notification", body: "No migration messages" } });
    const register = await prisma.cashRegisterSession.create({ data: { ...scope, businessDate: "2026-06-01", openingCashYen: 10000, createRequestId: "SYNTHETIC-REGISTER", openedByUserId: contexts.writer.user.id } });
    const checkout = await prisma.cashCheckout.create({ data: { ...scope, reservationId: reservation.id, reservationSnapshot: { synthetic: true }, legacyPaymentStatus: "PAID", taxBreakdown: [], totalYen: 7654, createRequestId: "SYNTHETIC-CHECKOUT", createdByUserId: contexts.writer.user.id } });
    await prisma.cashCheckoutItem.create({ data: { ...scope, checkoutId: checkout.id, lineNumber: 1, label: "Synthetic cash item", quantity: 1, unitPriceYen: 7654, discountYen: 0, taxRate: 10, taxYen: 696, totalYen: 7654 } });
    await prisma.cashPaymentAllocation.create({ data: { ...scope, checkoutId: checkout.id, method: "CARD", amountYen: 7654 } });
    await prisma.cashRegisterMovement.create({ data: { ...scope, sessionId: register.id, checkoutId: checkout.id, kind: "IN", amountYen: 100, reason: "Synthetic movement", requestId: "SYNTHETIC-MOVEMENT", requestHash: "a".repeat(64), createdByUserId: contexts.writer.user.id } });
    const chart = await prisma.treatmentChart.create({ data: { ...scope, reservationId: reservation.id, customerId: customer.id, staffId: current.id, customerName: customer.name, staffName: current.name, serviceId: service.id, serviceName: service.name, startsAt: reservation.startsAt, endsAt: reservation.endsAt } });
    const revision = await prisma.treatmentChartRevision.create({ data: { ...scope, chartId: chart.id, revisionNumber: 1, treatmentAt: reservation.startsAt, skinObservations: "PRIVATE-SYNTHETIC-CLINICAL OBSERVATION", createdByUserId: contexts.writer.user.id } });
    const photo = await prisma.treatmentChartPhoto.create({ data: { ...scope, chartId: chart.id, phase: "BEFORE", mimeType: "image/png", width: 1, height: 1, byteSize: 1, data: Buffer.from([1]) } });
    await prisma.treatmentChartRevisionPhoto.create({ data: { ...scope, chartId: chart.id, revisionId: revision.id, photoId: photo.id } });
    const makeHistory = (index: number, extra: Record<string, unknown> = {}) => ({
      ...scope, source: "SALONBOARD", sourceStoreId, externalReservationId: `SYNTHETIC-HISTORY-${index}`,
      externalStaffId: index < 3 ? publicationId : null, staffName: index < 3 ? "SYNTHETIC ORIGINAL CURRENT LABEL" : legacyNames[index - 3],
      customerName: `PRIVATE-SYNTHETIC-CUSTOMER-${index}`, customerKana: `SYNTHETIC-KANA-${index}`, customerNumber: `SYNTHETIC-${index}`,
      sourceStatus: ["会計済み", "サロンキャンセル", "受付待ち", "無断キャンセル", "お客様キャンセル"][index % 5],
      startsAt: new Date(`2025-11-${String(index + 1).padStart(2, "0")}T01:00:00Z`), endsAt: new Date(`2025-11-${String(index + 1).padStart(2, "0")}T01:30:00Z`), durationMinutes: 30,
      menuText: `SYNTHETIC SOURCE MENU ${index}`, reservationAmount: index % 2 ? null : 9876, sourceRoute: "SOURCE-ONLINE", nominated: true,
      rawHeaders: ["メモ", "メモ"], rawValues: [`PRIVATE-SYNTHETIC-CLINICAL-${index}`, "  SOURCE WHITESPACE\n"], capturedAt: new Date("2026-10-14T01:00:00Z"), ...extra
    });
    const histories = [];
    for (let index = 0; index < 5; index++) histories.push(await prisma.historicalReservation.create({ data: makeHistory(index) }));
    await prisma.historicalReservation.create({ data: makeHistory(0, { ...otherScope, externalReservationId: "SYNTHETIC-OTHER-SALON" }) });
    await prisma.historicalReservation.create({ data: makeHistory(0, { ...foreignScope, externalReservationId: "SYNTHETIC-FOREIGN-TENANT" }) });
    await prisma.historicalReservation.create({ data: makeHistory(3, { source: "SYNTHETIC-OTHER-SOURCE", externalReservationId: "SYNTHETIC-OTHER-SOURCE" }) });
    await prisma.historicalReservation.create({ data: makeHistory(3, { sourceStoreId: "H000999999", externalReservationId: "SYNTHETIC-OTHER-STORE" }) });
    await prisma.historicalReservation.create({ data: makeHistory(3, { externalReservationId: "SYNTHETIC-BEFORE-PERIOD", startsAt: new Date("2025-10-13T14:59:59Z"), endsAt: new Date("2025-10-13T15:29:59Z") }) });
    await prisma.historicalReservation.create({ data: makeHistory(4, { externalReservationId: "SYNTHETIC-AFTER-PERIOD", startsAt: new Date("2026-10-13T15:00:00Z"), endsAt: new Date("2026-10-13T15:30:00Z") }) });
    const snapshotTables = async (tables: string[]) => Object.fromEntries(await Promise.all(tables.map(async (table) => {
      const rows = await prisma.$queryRawUnsafe<{ snapshot: unknown }[]>(`SELECT to_jsonb(t) AS snapshot FROM "${table}" t ORDER BY to_jsonb(t)::text`);
      return [table, rows.map((row) => row.snapshot)];
    })));
    const baseline = await snapshotTables(untouchedTables);
    const originalHistory = await prisma.historicalReservation.findMany({ orderBy: { id: "asc" } });
    const originalStaff = await prisma.staff.findMany({ orderBy: { id: "asc" } });
    const originalMappings = await prisma.staffExternalRecord.findMany({ orderBy: { id: "asc" } });
    const assertNoLinksOrStaffChanges = async () => {
      assert.deepEqual(await prisma.historicalReservation.findMany({ orderBy: { id: "asc" } }), originalHistory);
      assert.deepEqual(await prisma.staff.findMany({ orderBy: { id: "asc" } }), originalStaff);
      assert.deepEqual(await prisma.staffExternalRecord.findMany({ orderBy: { id: "asc" } }), originalMappings);
    };

    await t.test("authentication, all three permissions and strict request schemas reject without writes", async () => {
      for (const suffix of ["prepare", "apply"] as const) {
        const payload = suffix === "prepare" ? {} : { checksum: "a".repeat(64) };
        assert.equal((await call(suffix, payload, "missing")).statusCode, 401);
        for (const key of ["reader", "none", "foreign", ...permissions.map((permission) => `missing-${permission}`)]) assert.equal((await call(suffix, payload, key)).statusCode, 403, key);
      }
      assert.equal((await call("prepare", { tenantId: foreignTenant.id })).statusCode, 400);
      for (const payload of [{}, { checksum: "invalid" }, { checksum: "a".repeat(64), staffId: current.id }]) assert.equal((await call("apply", payload)).statusCode, 400);
      await assertNoLinksOrStaffChanges();
      assert.deepEqual(await snapshotTables(untouchedTables), baseline);
    });

    await t.test("preparation is read-only and identical source plans have identical checksums", async () => {
      const one = await prepared(); const two = await prepared();
      assert.equal(one.checksum, two.checksum);
      await assertNoLinksOrStaffChanges();
      assert.deepEqual(await snapshotTables(untouchedTables), baseline);
    });

    await t.test("same-name manual staff is a conflict and is never merged or overwritten", async () => {
      const plan = await prepared();
      const manual = await prisma.staff.create({ data: { ...scope, name: legacyNames[0], kana: "MANUAL KANA", role: "MANAGER", color: "#fedcba", active: true, comment: "SYNTHETIC UNMAPPED MANUAL MASTER" } });
      try {
        const review = await call("prepare"); assert.equal(review.statusCode, 200, review.body); assert.equal(review.json().ready, false, review.body);
        assert.equal((await call("apply", { checksum: plan.checksum })).statusCode, 409);
        assert.deepEqual(await prisma.staff.findUniqueOrThrow({ where: { id: manual.id } }), manual);
        assert.equal(await prisma.staffExternalRecord.count(), originalMappings.length);
        assert.equal(await prisma.historicalReservation.count({ where: { staffId: { not: null } } }), 0);
      } finally { await prisma.staff.delete({ where: { id: manual.id } }); }
      await assertNoLinksOrStaffChanges();
    });

    await t.test("changed source records or publication mappings invalidate an already reviewed plan", async () => {
      const plan = await prepared();
      await prisma.historicalReservation.update({ where: { id: histories[4].id }, data: { staffName: "SYNTHETIC CHANGED LEGACY LABEL" } });
      try { assert.equal((await call("apply", { checksum: plan.checksum })).statusCode, 409); }
      finally { await prisma.historicalReservation.update({ where: { id: histories[4].id }, data: { staffName: legacyNames[1] } }); }
      await prisma.staffExternalRecord.update({ where: { id: currentMapping.id }, data: { staffId: alternate.id } });
      try { assert.equal((await call("apply", { checksum: plan.checksum })).statusCode, 409); }
      finally { await prisma.staffExternalRecord.update({ where: { id: currentMapping.id }, data: { staffId: current.id } }); }
      await assertNoLinksOrStaffChanges();
    });

    await t.test("missing exact publication mapping refuses a name fallback", async () => {
      await prisma.historicalReservation.update({ where: { id: histories[0].id }, data: { externalStaffId: "SYNTHETIC-NOT-MAPPED" } });
      try {
        const review = await call("prepare"); assert.equal(review.statusCode, 200, review.body); assert.equal(review.json().ready, false, review.body);
        assert.equal((await call("apply", { checksum: review.json().checksum })).statusCode, 409);
      } finally { await prisma.historicalReservation.update({ where: { id: histories[0].id }, data: { externalStaffId: publicationId } }); }
      await assertNoLinksOrStaffChanges();
    });

    await t.test("revoked permissions, disabled actor and changed tenant binding are re-read before mutations", async () => {
      const plan = await prepared();
      for (const missing of permissions) {
        await prisma.tenantMembership.update({ where: { tenantId_userId: { tenantId: tenant.id, userId: contexts.writer.user.id } }, data: { permissions: permissions.filter((permission) => permission !== missing) } });
        try { assert.equal((await call("apply", { checksum: plan.checksum })).statusCode, 403, missing); }
        finally { await prisma.tenantMembership.update({ where: { tenantId_userId: { tenantId: tenant.id, userId: contexts.writer.user.id } }, data: { permissions } }); }
      }
      await prisma.appUser.update({ where: { id: contexts.writer.user.id }, data: { disabled: true } });
      try { assert.equal((await call("apply", { checksum: plan.checksum })).statusCode, 403); }
      finally { await prisma.appUser.update({ where: { id: contexts.writer.user.id }, data: { disabled: false } }); }
      await prisma.tenant.update({ where: { id: tenant.id }, data: { slug: `history-staff-renamed-${marker}` } });
      try { assert.equal((await call("apply", { checksum: plan.checksum })).statusCode, 403); }
      finally { await prisma.tenant.update({ where: { id: tenant.id }, data: { slug: "missmrs-takamatsu" } }); }
      await assertNoLinksOrStaffChanges();
    });

    await t.test("a late link rejection rolls back all staff, mappings, links and the apply audit", async () => {
      const plan = await prepared();
      const auditBefore = await prisma.auditLog.count();
      const constraint = `history_staff_rollback_${marker}`;
      await prisma.$executeRawUnsafe(`ALTER TABLE "HistoricalReservation" ADD CONSTRAINT "${constraint}" CHECK ("externalReservationId" <> 'SYNTHETIC-HISTORY-4' OR "staffId" IS NULL)`);
      try {
        const failed = await call("apply", { checksum: plan.checksum });
        assert.equal(failed.statusCode, 500, failed.body);
        assert(!failed.body.includes("PRIVATE-SYNTHETIC")); assert(!failed.body.includes("SYNTHETIC-HISTORY"));
        await assertNoLinksOrStaffChanges();
        assert.equal(await prisma.auditLog.count(), auditBefore);
      } finally { await prisma.$executeRawUnsafe(`ALTER TABLE "HistoricalReservation" DROP CONSTRAINT "${constraint}"`); }
    });

    await t.test("concurrent apply and subsequent retries create each legacy identity once and preserve source data", async () => {
      const plan = await prepared();
      const responses = await Promise.all([0, 1].map(() => call("apply", { checksum: plan.checksum })));
      for (const response of responses) {
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert(!response.body.includes("PRIVATE-SYNTHETIC"));
      }
      const repeated = await call("apply", { checksum: plan.checksum }); assert.equal(repeated.statusCode, 200, repeated.body);
      assert.equal((await prepared()).checksum, plan.checksum, "Assignment changes and generated legacy IDs must not invalidate an identical logical plan");
      const mappings = await prisma.staffExternalRecord.findMany({ where: { ...scope, source: "SALONBOARD", sourceStoreId }, include: { staff: true } });
      assert.equal(mappings.length, 3);
      const legacyMappings = mappings.filter((mapping) => mapping.externalRecordKey !== publicationKey);
      assert.equal(legacyMappings.length, 2); assert.equal(new Set(legacyMappings.map((mapping) => mapping.staffId)).size, 2);
      for (const name of legacyNames) {
        const mapping = legacyMappings.find((value) => value.externalRecordKey === historyStaffSnapshotKey(sourceStoreId, name)); assert(mapping);
        assert.equal(mapping.staff.name, name); assert.equal(mapping.staff.active, false); assert.equal(mapping.staff.kana, "");
        assert.equal((mapping.profile as { identityKind: string }).identityKind, "SOURCE_HISTORY_STAFF_LABEL_SNAPSHOT");
      }
      assert.equal(await prisma.staff.count(), originalStaff.length + 2);
      const linked = await prisma.historicalReservation.findMany({ orderBy: { id: "asc" } });
      assert.deepEqual(linked.map(({ staffId: _staffId, ...value }) => value), originalHistory.map(({ staffId: _staffId, ...value }) => value));
      for (const record of linked) {
        const originalIndex = histories.findIndex((history) => history.id === record.id);
        if (originalIndex < 0) { assert.equal(record.staffId, null, "Other source, period, store, salon and tenant remain untouched"); continue; }
        const expected = originalIndex < 3 ? current.id : legacyMappings.find((mapping) => mapping.externalRecordKey === historyStaffSnapshotKey(sourceStoreId, legacyNames[originalIndex - 3]))!.staffId;
        assert.equal(record.staffId, expected);
      }
      for (const staff of originalStaff) assert.deepEqual(await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } }), staff);
      for (const mapping of originalMappings) assert.deepEqual(await prisma.staffExternalRecord.findUniqueOrThrow({ where: { id: mapping.id } }), mapping);
      const audits = await prisma.auditLog.findMany(); assert(!JSON.stringify(audits).includes("PRIVATE-SYNTHETIC"));
    });

    await t.test("manual edits to an already mapped legacy master survive another apply", async () => {
      const plan = await prepared();
      const mapping = await prisma.staffExternalRecord.findFirstOrThrow({ where: { ...scope, externalRecordKey: historyStaffSnapshotKey(sourceStoreId, legacyNames[0]) } });
      const changed = await prisma.staff.update({ where: { id: mapping.staffId }, data: { name: "SYNTHETIC MANUAL LEGACY NAME", comment: "SYNTHETIC MANUAL LEGACY COMMENT", color: "#abcdef", sortOrder: 789 } });
      const response = await call("apply", { checksum: plan.checksum }); assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(await prisma.staff.findUniqueOrThrow({ where: { id: mapping.staffId } }), changed);
      assert.equal(await prisma.staff.count(), originalStaff.length + 2);
      assert.equal(await prisma.staffExternalRecord.count(), originalMappings.length + 2);
    });

    await t.test("scoped staff foreign keys reject another salon or tenant and preserve linked staff on deletion", async () => {
      for (const staffId of [otherStaff.id, foreignStaff.id]) await assert.rejects(() => prisma.historicalReservation.update({ where: { id: histories[0].id }, data: { staffId } }));
      assert.equal((await prisma.historicalReservation.findUniqueOrThrow({ where: { id: histories[0].id } })).staffId, current.id);
      const mapping = await prisma.staffExternalRecord.findFirstOrThrow({ where: { ...scope, externalRecordKey: historyStaffSnapshotKey(sourceStoreId, legacyNames[1]) } });
      await assert.rejects(() => prisma.staff.delete({ where: { id: mapping.staffId } }));
      assert.equal(await prisma.historicalReservation.count({ where: { ...scope, staffId: mapping.staffId } }), 1);
      assert.equal((await prisma.staff.findUniqueOrThrow({ where: { id: mapping.staffId } })).active, false);
    });

    await t.test("operational reservations, cash, charts, customers, shifts, notifications and accounts remain byte-equivalent", async () => {
      // Access-revocation fixtures intentionally touched actor timestamps; every
      // other actor/access field and all salon operations retain the baseline.
      const operations = untouchedTables.filter((table) => !["Tenant", "AppUser", "TenantMembership"].includes(table));
      assert.deepEqual(await snapshotTables(operations), Object.fromEntries(operations.map((table) => [table, baseline[table]])));
      const policy = await snapshotTables(["Tenant", "AppUser", "TenantMembership"]);
      const removeTimestamp = (values: unknown) => (values as Record<string, unknown>[]).map(({ updatedAt: _updatedAt, ...value }) => value);
      for (const table of ["Tenant", "AppUser", "TenantMembership"]) assert.deepEqual(removeTimestamp(policy[table]), removeTimestamp(baseline[table]));
      assert.equal(await prisma.appUser.count(), userIds.length);
      assert.equal(await prisma.tenantMembership.count(), userIds.length);
    });
  } finally {
    await server.close();
    const scoped = { tenantId: { in: tenantIds } };
    await prisma.historicalReservation.deleteMany({ where: scoped });
    await prisma.treatmentChartRevisionPhoto.deleteMany({ where: scoped });
    await prisma.treatmentChartPhoto.deleteMany({ where: scoped });
    await prisma.treatmentChartRevision.deleteMany({ where: scoped });
    await prisma.treatmentChart.deleteMany({ where: scoped });
    await prisma.cashRegisterMovement.deleteMany({ where: scoped });
    await prisma.cashPaymentAllocation.deleteMany({ where: scoped });
    await prisma.cashCheckoutItem.deleteMany({ where: scoped });
    await prisma.cashCheckout.deleteMany({ where: scoped });
    await prisma.cashRegisterSession.deleteMany({ where: scoped });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
