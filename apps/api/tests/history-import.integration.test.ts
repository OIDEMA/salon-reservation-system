import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { hasPermission } from "../src/permissions.js";
import type { OperationContext } from "../src/operations-support.js";
import { staffNaturalKey, staffPublicationKey } from "../src/staff-import.js";
import { prepareHistoryManifest, type HistoryReservationRecord } from "../src/history-import.js";

const testDatabaseUrl = process.env.HISTORY_IMPORT_TEST_DATABASE_URL;
test("historical import is scoped, resumable and isolated from salon operations", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  const [{ prisma }, { registerHistoryImportRoutes }] = await Promise.all([import("../src/database.js"), import("../src/history-import-routes.js")]);
  const server = Fastify();
  const marker = randomUUID().replaceAll("-", "").slice(0, 8);
  const tenantIds: string[] = []; const userIds: string[] = [];
  const contexts: Record<string, OperationContext> = {};
  const root = "/api/admin/history-imports/salonboard";
  const historyRoot = "/api/admin/reservation-history";
  const sideEffectTables = ["Tenant", "Salon", "AppUser", "TenantMembership", "TenantInvitation", "Customer", "CustomerExternalRecord", "CustomerImportRun", "Staff", "StaffExternalRecord", "Service", "MenuCategory", "Equipment", "SalonSettings", "Reservation", "Shift", "Notification", "CashCheckout", "CashCheckoutItem", "CashPaymentAllocation", "CashRegisterSession", "CashRegisterMovement", "TreatmentChart", "TreatmentChartRevision", "TreatmentChartPhoto", "TreatmentChartRevisionPhoto"];
  try {
    const tenant = await prisma.tenant.create({ data: { slug: "missmrs-takamatsu", name: "Synthetic historical import" } }); tenantIds.push(tenant.id);
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic salon A" } });
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic salon B" } });
    const foreignTenant = await prisma.tenant.create({ data: { slug: `history-import-foreign-${marker}`, name: "Synthetic foreign tenant" } }); tenantIds.push(foreignTenant.id);
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "Synthetic foreign salon" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    const otherScope = { tenantId: tenant.id, salonId: otherSalon.id };
    const foreignScope = { tenantId: foreignTenant.id, salonId: foreignSalon.id };
    async function account(key: string, permissions: string[], selectedTenant = tenant, selectedSalon = salon) {
      const user = await prisma.appUser.create({ data: { firebaseUid: `history-import-${key}-${marker}`, displayName: "Synthetic actor" } }); userIds.push(user.id);
      const membership = await prisma.tenantMembership.create({ data: { tenantId: selectedTenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions, salonIds: [selectedSalon.id] } });
      contexts[key] = { tenant: selectedTenant, salon: selectedSalon, user, membership };
    }
    await account("writer", ["reservation.write", "chart.write"]);
    await account("reader", ["reservation.read"]);
    await account("clinical-reader", ["reservation.read", "chart.read"]);
    await account("no-chart", ["reservation.write"]);
    await account("no-reservation", ["chart.write"]);
    await account("none", []);
    await account("other", ["reservation.write", "chart.write"], tenant, otherSalon);
    await account("foreign", ["reservation.write", "chart.write"], foreignTenant, foreignSalon);
    await registerHistoryImportRoutes(server, { requireContext: async (request, reply, permission) => {
      const context = contexts[String(request.headers["x-test-context"] ?? "")];
      if (!context) { reply.code(401).send({ message: "Authentication required" }); return null; }
      if (!hasPermission(context, permission)) { reply.code(403).send({ message: "Permission denied" }); return null; }
      // Deliberately return stale snapshots; mutation paths must recheck the database.
      return { ...context, tenant: { ...context.tenant }, salon: { ...context.salon }, user: { ...context.user }, membership: { ...context.membership } };
    } });
    const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, key = "writer") => server.inject({ method, url, headers: { "x-test-context": key }, payload });
    const sourceStoreId = "H000551123";
    const staffSourceId = "STAFF-PUBLICATION-SYNTHETIC";
    const customer = await prisma.customer.create({ data: { ...scope, name: "Synthetic linked customer", kana: "SYNTHETIC KANA", visitCount: 12, totalSpent: 54321, lastVisitAt: new Date("2026-01-01T00:00:00Z"), memo: "SYNTHETIC CLINICAL MASTER NOTE" } });
    const staff = await prisma.staff.create({ data: { ...scope, name: "Synthetic linked staff", kana: "SYNTHETIC STAFF", role: "ESTHETICIAN", color: "#123456", active: false, parallelCapacity: 4, nominationFee: 777, comment: "SYNTHETIC MASTER STAFF NOTE" } });
    const service = await prisma.service.create({ data: { ...scope, name: "Synthetic local service", category: "Synthetic", durationMinutes: 15, price: 7654, color: "#123456", active: false } });
    const operational = await prisma.reservation.create({ data: { ...scope, customerId: customer.id, staffId: staff.id, serviceId: service.id, startsAt: new Date("2026-06-01T00:00:00Z"), endsAt: new Date("2026-06-01T00:15:00Z"), status: "COMPLETED", paymentStatus: "PAID", memo: "SYNTHETIC OPERATIONAL NOTE" } });
    await prisma.shift.create({ data: { ...scope, staffId: staff.id, label: "Synthetic shift", type: "AVAILABLE", startsAt: operational.startsAt, endsAt: operational.endsAt } });
    await prisma.notification.create({ data: { ...scope, kind: "Synthetic", title: "Synthetic existing notification", body: "No import messages" } });
    const register = await prisma.cashRegisterSession.create({ data: { ...scope, businessDate: "2026-06-01", openingCashYen: 10000, createRequestId: "SYNTHETIC-REGISTER", openedByUserId: contexts.writer.user.id } });
    const checkout = await prisma.cashCheckout.create({ data: { ...scope, reservationId: operational.id, reservationSnapshot: { synthetic: true }, legacyPaymentStatus: "PAID", taxBreakdown: [], totalYen: 7654, createRequestId: "SYNTHETIC-CHECKOUT", createdByUserId: contexts.writer.user.id } });
    await prisma.cashCheckoutItem.create({ data: { ...scope, checkoutId: checkout.id, lineNumber: 1, label: "Synthetic cash item", quantity: 1, unitPriceYen: 7654, discountYen: 0, taxRate: 10, taxYen: 696, totalYen: 7654 } });
    await prisma.cashPaymentAllocation.create({ data: { ...scope, checkoutId: checkout.id, method: "CARD", amountYen: 7654 } });
    await prisma.cashRegisterMovement.create({ data: { ...scope, sessionId: register.id, checkoutId: checkout.id, kind: "IN", amountYen: 100, reason: "Synthetic movement", requestId: "SYNTHETIC-MOVEMENT", requestHash: "a".repeat(64), createdByUserId: contexts.writer.user.id } });
    const chart = await prisma.treatmentChart.create({ data: { ...scope, reservationId: operational.id, customerId: customer.id, staffId: staff.id, customerName: customer.name, staffName: staff.name, serviceId: service.id, serviceName: service.name, startsAt: operational.startsAt, endsAt: operational.endsAt } });
    const revision = await prisma.treatmentChartRevision.create({ data: { ...scope, chartId: chart.id, revisionNumber: 1, treatmentAt: operational.startsAt, skinObservations: "SYNTHETIC EXISTING CLINICAL OBSERVATION", createdByUserId: contexts.writer.user.id } });
    const photo = await prisma.treatmentChartPhoto.create({ data: { ...scope, chartId: chart.id, phase: "BEFORE", mimeType: "image/png", width: 1, height: 1, byteSize: 1, data: Buffer.from([1]) } });
    await prisma.treatmentChartRevisionPhoto.create({ data: { ...scope, chartId: chart.id, revisionId: revision.id, photoId: photo.id } });
    await prisma.customerExternalRecord.create({ data: { ...scope, customerId: customer.id, source: "SALONBOARD", sourceStoreId, externalCustomerId: "C-SYNTHETIC-EXACT", profile: { synthetic: true } } });
    await prisma.staffExternalRecord.create({ data: { ...scope, staffId: staff.id, source: "SALONBOARD", sourceStoreId, externalRecordKey: staffPublicationKey(sourceStoreId, staffSourceId), profile: { synthetic: true, publicationStaffId: staffSourceId } } });
    const otherCustomer = await prisma.customer.create({ data: { ...otherScope, name: "Synthetic foreign mapping customer", kana: "SYNTHETIC" } });
    const otherStaff = await prisma.staff.create({ data: { ...otherScope, name: "Synthetic foreign mapping staff", kana: "SYNTHETIC", role: "ESTHETICIAN", color: "#123456" } });
    const unlinkedCustomerId = "C-SYNTHETIC-OTHER-ONLY"; const unlinkedStaffId = "STAFF-SYNTHETIC-OTHER-ONLY";
    await prisma.customerExternalRecord.create({ data: { ...otherScope, customerId: otherCustomer.id, source: "SALONBOARD", sourceStoreId, externalCustomerId: unlinkedCustomerId, profile: {} } });
    await prisma.staffExternalRecord.create({ data: { ...otherScope, staffId: otherStaff.id, source: "SALONBOARD", sourceStoreId, externalRecordKey: staffPublicationKey(sourceStoreId, unlinkedStaffId), profile: {} } });
    for (const identity of [{ source: "SYNTHETIC-OTHER-SOURCE", sourceStoreId }, { source: "SALONBOARD", sourceStoreId: "H000-SYNTHETIC-OTHER" }]) {
      await prisma.customerExternalRecord.create({ data: { ...scope, customerId: customer.id, ...identity, externalCustomerId: unlinkedCustomerId, profile: {} } });
      await prisma.staffExternalRecord.create({ data: { ...scope, staffId: staff.id, ...identity, externalRecordKey: staffPublicationKey(sourceStoreId, unlinkedStaffId), profile: {} } });
    }
    await prisma.staffExternalRecord.create({ data: { ...scope, staffId: staff.id, source: "SALONBOARD", sourceStoreId, externalRecordKey: staffNaturalKey(sourceStoreId, staff.name, staff.kana), profile: { synthetic: true } } });
    const snapshotOperations = async () => Object.fromEntries(await Promise.all(sideEffectTables.map(async (table) => {
      // The table allowlist is fixed above; never interpolate input identifiers.
      const rows = await prisma.$queryRawUnsafe<{ snapshot: unknown }[]>(`SELECT to_jsonb(t) AS snapshot FROM "${table}" t ORDER BY to_jsonb(t)::text`);
      return [table, rows.map((row) => row.snapshot)];
    })));
    const baseline = await snapshotOperations();
    const makeRecord = (index: number): HistoryReservationRecord => {
      const boundaryTimes: Record<number, string> = { 6: "2025-11-01T15:00:00.000Z", 7: "2025-11-02T14:59:59.000Z", 8: "2025-11-02T15:00:00.000Z" };
      const startsAt = boundaryTimes[index] ?? new Date(Date.UTC(2025, 10, 1 + Math.floor(index / 2), index % 2 ? 1 : 0)).toISOString();
      return { externalReservationId: `R-SYNTHETIC-${String(index).padStart(3, "0")}`, externalCustomerId: index === 0 ? "C-SYNTHETIC-EXACT" : index === 1 ? unlinkedCustomerId : null,
        customerNumber: "SYNTHETIC-EDITABLE-CUSTOMER-NUMBER", externalStaffId: index === 0 ? staffSourceId : index === 1 ? unlinkedStaffId : null,
        customerName: index === 2 ? customer.name : `Synthetic customer ${String(index).padStart(3, "0")}`, customerKana: `SYNTHETIC KANA ${index}`, staffName: index === 2 ? staff.name : `Synthetic source staff ${index % 3}`,
        sourceStatus: index % 3 === 0 ? "来店済み" : index % 3 === 1 ? "キャンセル" : "SOURCE-UNKNOWN-STATUS", startsAt,
        endsAt: index % 4 ? new Date(new Date(startsAt).getTime() + 30 * 60000).toISOString() : null, durationMinutes: index % 4 ? 30 : null,
        menuText: `Synthetic source menu ${index % 4}`, reservationAmount: index % 4 ? index * 100 : null, sourceRoute: "SOURCE-ONLINE", nominated: index % 2 ? true : null, equipmentName: "Synthetic source equipment",
        rawHeaders: ["予約ID", "メモ", "メモ"], rawValues: [`R-SYNTHETIC-${String(index).padStart(3, "0")}`, `PRIVATE-SYNTHETIC-SOURCE-NOTE-${index}`, `  PRIVATE-SYNTHETIC-DUPLICATE-${index}\n  `] };
    };
    const records = Array.from({ length: 55 }, (_, index) => makeRecord(index));
    const envelope = { version: 1, source: "SALONBOARD", sourceStoreId, periodFrom: "2025-10-14", periodTo: "2026-10-14", capturedAt: "2026-10-14T01:00:00Z", expectedCount: records.length, records };
    let runId = ""; let firstHistoryId = ""; let otherHistoryId = "";

    await t.test("authentication, dual permissions, target/store scope and full validation reject before writes", async () => {
      assert.equal((await call("POST", `${root}/prepare`, envelope, "missing")).statusCode, 401);
      for (const key of ["reader", "none", "no-chart", "no-reservation", "foreign"]) assert.equal((await call("POST", `${root}/prepare`, envelope, key)).statusCode, 403);
      for (const invalid of [
        { ...envelope, expectedCount: 56 }, { ...envelope, records: [...records.slice(0, 54), records[0]] },
        { ...envelope, records: [...records.slice(0, 54), { ...records[54], customerName: "" }] },
        { ...envelope, records: [...records.slice(0, 54), { ...records[54], rawValues: [] }] },
        { ...envelope, records: [...records.slice(0, 54), { ...records[54], rawValues: ["x".repeat(65536), "x", "x"] }] },
        { ...envelope, records: [...records.slice(0, 54), { ...records[54], startsAt: "2026-10-14T00:00:00+09:00" }] },
        { ...envelope, records: [...records.slice(0, 54), { ...records[54], startsAt: "2025-11-01T10:00:00" }] },
        { ...envelope, records: [...records.slice(0, 54), { ...records[54], reservationAmount: -1 }] },
        { ...envelope, sourceStoreId: "H000999999" }, { ...envelope, periodTo: "2026-02-30" }, { ...envelope, unexpected: true }
      ]) assert.equal((await call("POST", `${root}/prepare`, invalid)).statusCode, 400);
      assert.equal(await prisma.historicalReservation.count(), 0); assert.equal(await prisma.historicalReservationImportRun.count(), 0); assert.equal(await prisma.auditLog.count(), 0);
      assert.deepEqual(await snapshotOperations(), baseline);
    });

    await t.test("concurrent prepare stores only hashes/counts and returns the identical manifest for safe resume", async () => {
      const prepared = await Promise.all([0, 1].map(() => call("POST", `${root}/prepare`, envelope)));
      for (const response of prepared) {
        assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers["cache-control"], "private, no-store");
        assert(!response.body.includes("PRIVATE-SYNTHETIC")); assert(!response.body.includes("Synthetic customer")); assert(!response.body.includes("recordHashes"));
      }
      runId = prepared[0].json().id; assert.equal(prepared[1].json().id, runId);
      const expected = prepareHistoryManifest(envelope);
      const stored = await prisma.historicalReservationImportRun.findUniqueOrThrow({ where: { id: runId } });
      assert.equal(stored.checksum, expected.checksum); assert.deepEqual(stored.recordHashes, expected.recordHashes); assert.deepEqual(stored.monthCounts, { "2025-11": 55 }); assert.deepEqual(stored.statusCounts, { ...expected.statusCounts });
      assert.equal(stored.expectedCount, 55); assert.equal(stored.createdCount, 0); assert.equal(stored.skippedCount, 0); assert.deepEqual(stored.processedOffsets, []);
      assert(!JSON.stringify(stored).includes("PRIVATE-SYNTHETIC")); assert(!JSON.stringify(stored).includes("Synthetic customer"));
      assert.equal((await call("GET", `${root}/${runId}`, undefined, "reader")).statusCode, 200);
      assert.equal((await call("GET", `${root}/${runId}`, undefined, "other")).statusCode, 404);
      assert.equal((await call("GET", `${root}/${runId}`, undefined, "foreign")).statusCode, 403);
      assert.equal((await call("GET", `${root}/${runId}`, undefined, "none")).statusCode, 403);
      assert.equal(await prisma.auditLog.count(), 1);
    });

    await t.test("prepared record hashes and exact chunk bounds reject altered, reordered or unprepared content", async () => {
      const changed = records.slice(0, 50).map((record) => ({ ...record })); changed[2].rawValues = ["Changed", "Changed", "Changed"];
      for (const payload of [{ offset: 0, records: changed }, { offset: 0, records: records.slice(0, 50).reverse() }, { offset: 0, records: records.slice(0, 49) }, { offset: 1, records: records.slice(0, 50) }, { offset: 100, records: [records[0]] }, { offset: 50, records: records.slice(50, 54) }]) {
        assert.equal((await call("POST", `${root}/${runId}/chunks`, payload)).statusCode, 400);
      }
      assert.equal((await call("POST", `${root}/${runId}/chunks`, { offset: 0, records: records.slice(0, 50) }, "other")).statusCode, 404);
      for (const key of ["reader", "no-chart", "no-reservation", "foreign"]) assert.equal((await call("POST", `${root}/${runId}/chunks`, { offset: 0, records: records.slice(0, 50) }, key)).statusCode, 403);
      assert.equal(await prisma.historicalReservation.count(), 0); assert.equal(await prisma.auditLog.count(), 1);
    });

    await t.test("a late row rejection atomically rolls back all rows, import offsets, totals and audits", async () => {
      const constraint = `history_import_rollback_${marker}`;
      await prisma.$executeRawUnsafe(`ALTER TABLE "HistoricalReservation" ADD CONSTRAINT "${constraint}" CHECK ("externalReservationId" <> 'R-SYNTHETIC-002')`);
      try {
        const failed = await call("POST", `${root}/${runId}/chunks`, { offset: 0, records: records.slice(0, 50) });
        assert.equal(failed.statusCode, 500, failed.body); assert(!failed.body.includes("R-SYNTHETIC")); assert(!failed.body.includes("PRIVATE-SYNTHETIC"));
        assert.equal(await prisma.historicalReservation.count(), 0); assert.equal(await prisma.auditLog.count(), 1);
        const stored = await prisma.historicalReservationImportRun.findUniqueOrThrow({ where: { id: runId } });
        assert.deepEqual(stored.processedOffsets, []); assert.equal(stored.createdCount, 0); assert.equal(stored.skippedCount, 0); assert.equal(stored.completedAt, null);
      } finally { await prisma.$executeRawUnsafe(`ALTER TABLE "HistoricalReservation" DROP CONSTRAINT "${constraint}"`); }
    });

    await t.test("out-of-order resume and concurrent same-chunk retries create each source reservation exactly once", async () => {
      const last = await call("POST", `${root}/${runId}/chunks`, { offset: 50, records: records.slice(50) });
      assert.equal(last.statusCode, 200, last.body); assert.equal(last.json().processedCount, 5); assert.deepEqual(last.json().processedOffsets, [50]);
      const results = await Promise.all([0, 1].map(() => call("POST", `${root}/${runId}/chunks`, { offset: 0, records: records.slice(0, 50) })));
      for (const response of results) { assert.equal(response.statusCode, 200, response.body); assert(!response.body.includes("PRIVATE-SYNTHETIC")); }
      assert.deepEqual(results.map((response) => response.json().chunk.alreadyProcessed).sort(), [false, true]);
      const summary = (await call("GET", `${root}/${runId}`, undefined, "reader")).json();
      assert.equal(summary.completed, true); assert.equal(summary.createdCount, 55); assert.equal(summary.skippedCount, 0); assert.equal(summary.remainingCount, 0); assert.deepEqual(summary.processedOffsets, [0, 50]);
      assert.equal(await prisma.historicalReservation.count({ where: scope }), 55);
      const rows = await prisma.historicalReservation.findMany({ where: scope });
      assert.equal(new Set(rows.map((row) => row.externalReservationId)).size, 55);
      firstHistoryId = rows.find((row) => row.externalReservationId === records[0].externalReservationId)!.id;
      assert.equal(rows.find((row) => row.externalReservationId === records[0].externalReservationId)!.reservationAmount, null);
      assert.equal(rows.find((row) => row.externalReservationId === records[2].externalReservationId)!.normalizedStatus, null);
      assert.deepEqual(rows.find((row) => row.id === firstHistoryId)!.rawHeaders, records[0].rawHeaders);
      assert.deepEqual(rows.find((row) => row.id === firstHistoryId)!.rawValues, records[0].rawValues);
      assert.deepEqual(await snapshotOperations(), baseline);
    });

    await t.test("later captures skip existing IDs and preserve manually amended historical snapshots", async () => {
      await prisma.historicalReservation.update({ where: { id: firstHistoryId }, data: { customerName: "Synthetic manual snapshot", sourceStatus: "SYNTHETIC-MANUAL-STATUS", reservationAmount: 9876, rawValues: ["MANUAL", "PRIVATE-SYNTHETIC-MANUAL-NOTE", "MANUAL"] } });
      const later = await call("POST", `${root}/prepare`, { ...envelope, capturedAt: "2026-10-14T02:00:00Z", records: records.map((record) => ({ ...record, customerName: "Synthetic changed source snapshot" })) });
      assert.equal(later.statusCode, 200, later.body); assert.notEqual(later.json().id, runId);
      const laterRecords = records.map((record) => ({ ...record, customerName: "Synthetic changed source snapshot" }));
      await call("POST", `${root}/${later.json().id}/chunks`, { offset: 0, records: laterRecords.slice(0, 50) });
      const complete = await call("POST", `${root}/${later.json().id}/chunks`, { offset: 50, records: laterRecords.slice(50) });
      assert.equal(complete.statusCode, 200, complete.body); assert.equal(complete.json().createdCount, 0); assert.equal(complete.json().skippedCount, 55);
      const preserved = await prisma.historicalReservation.findUniqueOrThrow({ where: { id: firstHistoryId } });
      assert.equal(preserved.customerName, "Synthetic manual snapshot"); assert.equal(preserved.sourceStatus, "SYNTHETIC-MANUAL-STATUS"); assert.equal(preserved.reservationAmount, 9876); assert.equal(preserved.rawValues[1], "PRIVATE-SYNTHETIC-MANUAL-NOTE");
      assert.equal(await prisma.historicalReservation.count({ where: scope }), 55);
    });

    await t.test("concurrent overlapping manifests skip shared IDs without duplicate snapshots or inflated run counts", async () => {
      const a = Array.from({ length: 50 }, (_, index) => makeRecord(35 + index));
      const b = Array.from({ length: 50 }, (_, index) => makeRecord(55 + index));
      const runs = await Promise.all([a, b].map((values) => call("POST", `${root}/prepare`, { ...envelope, expectedCount: values.length, records: values })));
      for (const response of runs) assert.equal(response.statusCode, 200, response.body);
      const chunks = await Promise.all([a, b].map((values, index) => call("POST", `${root}/${runs[index].json().id}/chunks`, { offset: 0, records: values })));
      for (const response of chunks) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().processedCount, 50); assert.equal(response.json().completed, true); }
      assert.equal(chunks.reduce((sum, response) => sum + response.json().createdCount, 0), 50); assert.equal(chunks.reduce((sum, response) => sum + response.json().skippedCount, 0), 50);
      assert.equal(await prisma.historicalReservation.count({ where: scope }), 105);
      const other = await call("POST", `${root}/prepare`, envelope, "other"); assert.equal(other.statusCode, 200, other.body);
      const otherChunk = await call("POST", `${root}/${other.json().id}/chunks`, { offset: 50, records: records.slice(50) }, "other"); assert.equal(otherChunk.statusCode, 200, otherChunk.body); assert.equal(otherChunk.json().createdCount, 5);
      otherHistoryId = (await prisma.historicalReservation.findFirstOrThrow({ where: otherScope })).id;
      const foreign = records[0];
      await prisma.historicalReservation.create({ data: { ...foreign, ...foreignScope, source: "SALONBOARD", sourceStoreId, sourceStatus: "FOREIGN-ONLY-STATUS", startsAt: new Date(foreign.startsAt), endsAt: null, capturedAt: new Date(envelope.capturedAt) } });
    });

    await t.test("details resolve exact source identifiers read-only and require chart reading for original duplicate columns", async () => {
      const plain = await call("GET", `${historyRoot}/${firstHistoryId}`, undefined, "reader");
      assert.equal(plain.statusCode, 200, plain.body); assert.equal(plain.json().customerId, customer.id); assert.equal(plain.json().staffId, staff.id); assert.equal(plain.json().canReadOriginal, false);
      assert.equal("rawHeaders" in plain.json(), false); assert.equal("rawValues" in plain.json(), false); assert(!plain.body.includes("PRIVATE-SYNTHETIC-MANUAL"));
      const clinical = await call("GET", `${historyRoot}/${firstHistoryId}`, undefined, "clinical-reader");
      assert.equal(clinical.statusCode, 200, clinical.body); assert.equal(clinical.json().canReadOriginal, true); assert.deepEqual(clinical.json().rawHeaders, ["予約ID", "メモ", "メモ"]); assert.equal(clinical.json().rawValues[1], "PRIVATE-SYNTHETIC-MANUAL-NOTE");
      const rawRetained = await prisma.historicalReservation.findFirstOrThrow({ where: { ...scope, externalReservationId: records[1].externalReservationId } });
      const unavailableMapping = await call("GET", `${historyRoot}/${rawRetained.id}`, undefined, "clinical-reader");
      assert.equal(unavailableMapping.json().customerId, null); assert.equal(unavailableMapping.json().staffId, null); assert.deepEqual(unavailableMapping.json().rawValues, records[1].rawValues);
      const nameOnly = await prisma.historicalReservation.findFirstOrThrow({ where: { ...scope, externalReservationId: records[2].externalReservationId } });
      const noNameMatch = (await call("GET", `${historyRoot}/${nameOnly.id}`, undefined, "clinical-reader")).json(); assert.equal(noNameMatch.customerId, null); assert.equal(noNameMatch.staffId, null);
      assert.equal((await call("GET", `${historyRoot}/${firstHistoryId}`, undefined, "other")).statusCode, 404);
      assert.equal((await call("GET", `${historyRoot}/${otherHistoryId}`, undefined, "reader")).statusCode, 404);
      assert.equal((await call("GET", `${historyRoot}/${firstHistoryId}`, undefined, "foreign")).statusCode, 404);
      assert.equal((await call("GET", `${historyRoot}/${firstHistoryId}`, undefined, "none")).statusCode, 403);
      assert.deepEqual(await snapshotOperations(), baseline);
    });

    await t.test("database pagination filters by JST dates/status/query and clamps pages with stable bounded summaries", async () => {
      const first = await call("GET", `${historyRoot}/page`, undefined, "reader"); assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().items.length, 50); assert.equal(first.json().total, 105); assert.equal(first.json().totalPages, 3); assert.equal(first.json().pageSize, 50);
      assert(!first.body.includes("rawHeaders")); assert(!first.body.includes("rawValues")); assert(!first.body.includes("PRIVATE-SYNTHETIC")); assert(!first.body.includes("customerNumber")); assert(!first.body.includes("externalCustomerId")); assert(!first.json().statusOptions.includes("FOREIGN-ONLY-STATUS"));
      const expected = await prisma.historicalReservation.findMany({ where: scope, orderBy: [{ startsAt: "desc" }, { id: "desc" }], take: 50, select: { id: true } }); assert.deepEqual(first.json().items.map((item: { id: string }) => item.id), expected.map((item) => item.id));
      const last = await call("GET", `${historyRoot}/page?page=999999&pageSize=100`, undefined, "reader"); assert.equal(last.json().page, 2); assert.equal(last.json().items.length, 5); assert.equal(last.json().totalPages, 2);
      const second = (await call("GET", `${historyRoot}/page?page=2`, undefined, "reader")).json(); assert(!second.items.some((item: { id: string }) => first.json().items.some((previous: { id: string }) => previous.id === item.id)));
      const filtered = await call("GET", `${historyRoot}/page?from=2025-11-02&to=2025-11-02&sourceStatus=${encodeURIComponent("キャンセル")}`, undefined, "reader");
      const expectedFiltered = await prisma.historicalReservation.findMany({ where: { ...scope, startsAt: { gte: new Date("2025-11-02T00:00:00+09:00"), lt: new Date("2025-11-03T00:00:00+09:00") }, sourceStatus: "キャンセル" }, orderBy: [{ startsAt: "desc" }, { id: "desc" }] });
      assert.equal(filtered.statusCode, 200, filtered.body); assert.equal(filtered.json().total, expectedFiltered.length); assert.deepEqual(filtered.json().items.map((item: { id: string }) => item.id), expectedFiltered.map((item) => item.id));
      const jstDay = (await call("GET", `${historyRoot}/page?from=2025-11-02&to=2025-11-02`, undefined, "reader")).json();
      assert.equal(jstDay.total, 4); const dayIds = jstDay.items.map((item: { externalReservationId: string }) => item.externalReservationId);
      assert(dayIds.includes("R-SYNTHETIC-006")); assert(dayIds.includes("R-SYNTHETIC-007")); assert(!dayIds.includes("R-SYNTHETIC-008"));
      for (const query of ["r-synthetic-080", "synthetic kana 80"]) { const searched = (await call("GET", `${historyRoot}/page?q=${encodeURIComponent(query)}`, undefined, "reader")).json(); assert.equal(searched.total, 1); assert.equal(searched.items[0].externalReservationId, "R-SYNTHETIC-080"); }
      const menuSearch = (await call("GET", `${historyRoot}/page?q=${encodeURIComponent("Synthetic source menu 3")}`, undefined, "reader")).json(); assert.equal(menuSearch.total, await prisma.historicalReservation.count({ where: { ...scope, menuText: { contains: "Synthetic source menu 3" } } }));
      const noNotesSearch = (await call("GET", `${historyRoot}/page?q=PRIVATE-SYNTHETIC-SOURCE-NOTE`, undefined, "reader")).json(); assert.equal(noNotesSearch.total, 0);
      const empty = (await call("GET", `${historyRoot}/page?q=SYNTHETIC-NOT-PRESENT&page=999`, undefined, "reader")).json(); assert.equal(empty.page, 1); assert.equal(empty.totalPages, 1); assert.equal(empty.total, 0); assert.deepEqual(empty.items, []);
      const other = (await call("GET", `${historyRoot}/page`, undefined, "other")).json(); assert.equal(other.total, 5);
      for (const query of ["pageSize=101", "page=0", "from=2025-02-30", "from=2026-01-01&to=2025-01-01", `q=${"x".repeat(101)}`]) assert.equal((await call("GET", `${historyRoot}/page?${query}`, undefined, "reader")).statusCode, 400);
      assert.equal((await call("GET", `${historyRoot}/page`, undefined, "missing")).statusCode, 401); assert.equal((await call("GET", `${historyRoot}/page`, undefined, "none")).statusCode, 403);
    });

    await t.test("stale write contexts recheck both permissions, actors, target identity and salon scope before mutation", async () => {
      const newRecord = makeRecord(200); const newEnvelope = { ...envelope, expectedCount: 1, records: [newRecord] };
      const waiting = await call("POST", `${root}/prepare`, newEnvelope); assert.equal(waiting.statusCode, 200, waiting.body); const waitingId = waiting.json().id;
      const membershipId = { tenantId_userId: { tenantId: tenant.id, userId: contexts.writer.user.id } };
      const existingCount = await prisma.historicalReservation.count(); const runCount = await prisma.historicalReservationImportRun.count(); const auditCount = await prisma.auditLog.count();
      const rejectBoth = async () => {
        assert.equal((await call("POST", `${root}/prepare`, { ...newEnvelope, capturedAt: "2026-10-14T03:00:00Z" })).statusCode, 403);
        assert.equal((await call("POST", `${root}/${waitingId}/chunks`, { offset: 0, records: [newRecord] })).statusCode, 403);
        assert.equal(await prisma.historicalReservation.count(), existingCount); assert.equal(await prisma.historicalReservationImportRun.count(), runCount); assert.equal(await prisma.auditLog.count(), auditCount);
      };
      for (const permissions of [["reservation.write"], ["chart.write"]]) { await prisma.tenantMembership.update({ where: membershipId, data: { permissions } }); await rejectBoth(); }
      await prisma.tenantMembership.update({ where: membershipId, data: { permissions: ["reservation.write", "chart.write"], salonIds: [otherSalon.id] } }); await rejectBoth();
      await prisma.tenantMembership.update({ where: membershipId, data: { salonIds: [salon.id], status: "SUSPENDED" } }); await rejectBoth();
      await prisma.tenantMembership.update({ where: membershipId, data: { status: "ACTIVE" } });
      await prisma.appUser.update({ where: { id: contexts.writer.user.id }, data: { disabled: true } }); await rejectBoth();
      await prisma.appUser.update({ where: { id: contexts.writer.user.id }, data: { disabled: false } });
      await prisma.tenant.update({ where: { id: tenant.id }, data: { slug: `history-renamed-${marker}` } }); await rejectBoth();
      await prisma.tenant.update({ where: { id: tenant.id }, data: { slug: "missmrs-takamatsu" } });
      // Timestamps change during these intentional policy fixtures; compare all other fields.
      const updatedBaseline = await snapshotOperations();
      for (const table of ["Tenant", "TenantMembership", "AppUser"]) { const removeTimestamp = (values: unknown) => (values as Record<string, unknown>[]).map(({ updatedAt: _updatedAt, ...value }) => value); assert.deepEqual(removeTimestamp(updatedBaseline[table]), removeTimestamp(baseline[table])); }
      for (const table of sideEffectTables.filter((name) => !["Tenant", "TenantMembership", "AppUser"].includes(name))) assert.deepEqual(updatedBaseline[table], baseline[table], `${table} remained unchanged`);
      const status = (await call("GET", `${root}/${waitingId}`, undefined, "reader")).json(); assert.equal(status.processedCount, 0); assert.deepEqual(status.processedOffsets, []);
    });

    await t.test("the historical API exposes no mutation controls and audit records contain only counts/identifiers", async () => {
      for (const method of ["POST", "PATCH", "DELETE"] as const) assert.equal((await call(method, `${historyRoot}/${firstHistoryId}`, { status: "COMPLETED" })).statusCode, 404);
      const audit = await prisma.auditLog.findMany({ where: { tenantId: { in: tenantIds } } });
      assert(!JSON.stringify(audit).includes("PRIVATE-SYNTHETIC")); assert(!JSON.stringify(audit).includes("Synthetic customer")); assert(!JSON.stringify(audit).includes("Synthetic source staff"));
      const operationsNow = await snapshotOperations();
      for (const table of sideEffectTables.filter((name) => !["Tenant", "TenantMembership", "AppUser"].includes(name))) assert.deepEqual(operationsNow[table], baseline[table], `${table} remained unchanged`);
    });
  } finally {
    await server.close();
    const scoped = { tenantId: { in: tenantIds } };
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
