import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { hasPermission } from "../src/permissions.js";
import type { OperationContext } from "../src/operations-support.js";

const databaseUrl = process.env.HISTORY_SCHEDULE_TEST_DATABASE_URL ?? process.env.OPERATIONS_TEST_DATABASE_URL;
test("historical schedule corrections are scoped, concurrent-safe and isolated from imported/operational records", { skip: !databaseUrl }, async (t) => {
  const target = new URL(databaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = databaseUrl;
  const [{ prisma }, { registerHistoryScheduleRoutes }, { registerHistoryImportRoutes }, { dashboardHistory, japanDayBounds, staffScheduleDependencyCount }] = await Promise.all([
    import("../src/database.js"), import("../src/history-schedule.js"), import("../src/history-import-routes.js"), import("../src/dashboard-history.js")
  ]);
  const server = Fastify();
  const marker = `history-schedule-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = []; const userIds: string[] = [];
  const contexts: Record<string, OperationContext> = {};
  try {
    const tenant = await prisma.tenant.create({ data: { slug: marker, name: "Synthetic schedule tenant" } }); tenantIds.push(tenant.id);
    const foreignTenant = await prisma.tenant.create({ data: { slug: `${marker}-foreign`, name: "Synthetic foreign tenant" } }); tenantIds.push(foreignTenant.id);
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic permitted salon" } });
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic other salon" } });
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "Synthetic foreign salon" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    const otherScope = { tenantId: tenant.id, salonId: otherSalon.id };
    const foreignScope = { tenantId: foreignTenant.id, salonId: foreignSalon.id };
    async function account(key: string, permissions: string[], selectedTenant = tenant, selectedSalon = salon) {
      const user = await prisma.appUser.create({ data: { firebaseUid: `${marker}-${key}` } }); userIds.push(user.id);
      const membership = await prisma.tenantMembership.create({ data: { tenantId: selectedTenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions, salonIds: [selectedSalon.id] } });
      contexts[key] = { tenant: selectedTenant, salon: selectedSalon, user, membership };
    }
    await account("writer", ["reservation.read", "reservation.write"]);
    await account("reader", ["reservation.read"]);
    await account("write-only", ["reservation.write"]);
    await account("revoked", ["reservation.read", "reservation.write"]);
    await account("other", ["reservation.read", "reservation.write"], tenant, otherSalon);
    await account("foreign", ["reservation.read", "reservation.write"], foreignTenant, foreignSalon);
    const requireContext = async (request: any, reply: any, permission: any) => {
      const context = contexts[String(request.headers["x-test-context"] ?? "")];
      if (!context) { reply.code(401).send({ message: "Authentication required" }); return null; }
      if (!hasPermission(context, permission)) { reply.code(403).send({ message: "Permission denied" }); return null; }
      return { ...context, tenant: { ...context.tenant }, salon: { ...context.salon }, user: { ...context.user }, membership: { ...context.membership } };
    };
    await registerHistoryScheduleRoutes(server, { requireContext });
    await registerHistoryImportRoutes(server, { requireContext });
    const staff = await prisma.staff.create({ data: { ...scope, name: "Synthetic original staff", kana: "", role: "ESTHETICIAN", color: "#111111", active: false } });
    const alternate = await prisma.staff.create({ data: { ...scope, name: "Synthetic alternate inactive", kana: "", role: "ESTHETICIAN", color: "#222222", active: false } });
    const otherStaff = await prisma.staff.create({ data: { ...otherScope, name: "Synthetic other staff", kana: "", role: "ESTHETICIAN", color: "#333333" } });
    const foreignStaff = await prisma.staff.create({ data: { ...foreignScope, name: "Synthetic foreign staff", kana: "", role: "ESTHETICIAN", color: "#444444" } });
    const customer = await prisma.customer.create({ data: { ...scope, name: "Synthetic operational customer", kana: "", visitCount: 7, totalSpent: 12345 } });
    const service = await prisma.service.create({ data: { ...scope, name: "Synthetic menu", category: "Synthetic", durationMinutes: 30, price: 4321, color: "#111111" } });
    await prisma.reservation.create({ data: { ...scope, customerId: customer.id, serviceId: service.id, staffId: staff.id, status: "COMPLETED", paymentStatus: "PAID", startsAt: new Date("2025-10-25T01:00:00Z"), endsAt: new Date("2025-10-25T01:30:00Z") } });
    const data = { ...scope, source: "SALONBOARD", sourceStoreId: "H000551123", customerName: "Synthetic historical customer", staffId: staff.id, staffName: "ORIGINAL-STAFF-LABEL", sourceStatus: "会計済み", startsAt: new Date("2025-10-25T23:30:00+09:00"), endsAt: new Date("2025-10-26T01:00:00+09:00"), durationMinutes: 90, reservationAmount: 7777, rawHeaders: ["メモ"], rawValues: ["PRIVATE-SYNTHETIC-NOTE"], capturedAt: new Date("2026-10-14T00:00:00Z") };
    const known = await prisma.historicalReservation.create({ data: { ...data, externalReservationId: `${marker}-known` } });
    const unknown = await prisma.historicalReservation.create({ data: { ...data, externalReservationId: `${marker}-unknown`, startsAt: new Date("2025-10-25T10:00:00+09:00"), endsAt: null, durationMinutes: null } });
    const racing = await prisma.historicalReservation.create({ data: { ...data, externalReservationId: `${marker}-racing`,
      startsAt: new Date("2025-10-24T10:00:00+09:00"), endsAt: new Date("2025-10-24T11:30:00+09:00") } });
    const sources = await prisma.historicalReservation.findMany({ where: scope, orderBy: { id: "asc" } });
    const snapshot = async () => ({
      reservations: await prisma.reservation.findMany({ where: scope }), customers: await prisma.customer.findMany({ where: scope }), staff: await prisma.staff.findMany({ where: scope, orderBy: { id: "asc" } }),
      shifts: await prisma.shift.count({ where: scope }), checkouts: await prisma.cashCheckout.count({ where: scope }), registers: await prisma.cashRegisterSession.count({ where: scope }), charts: await prisma.treatmentChart.count({ where: scope }), notifications: await prisma.notification.count({ where: scope })
    });
    const baseline = await snapshot();
    const baseInput = { date: "2025-10-25", startTime: "22:00", staffId: alternate.id, expectedVersion: 0 };
    const move = (id: string, payload: unknown = baseInput, key = "writer") => server.inject({ method: "PATCH", url: `/api/admin/reservation-history/${id}/schedule`, headers: { "x-test-context": key }, payload });
    const board = (date: string, q?: string) => dashboardHistory(prisma, scope, japanDayBounds(date), { status: "ALL", q });

    await t.test("read and write permissions are both required and refreshed inside the write transaction", async () => {
      assert.equal((await move(known.id, baseInput, "reader")).statusCode, 403);
      assert.equal(hasPermission(contexts["write-only"], "reservation.read"), true, "Existing policy grants read with write");
      await prisma.tenantMembership.update({ where: { tenantId_userId: { tenantId: tenant.id, userId: contexts.revoked.user.id } }, data: { permissions: ["reservation.read"] } });
      assert.equal((await move(known.id, baseInput, "revoked")).statusCode, 403);
      assert.equal(await prisma.historicalReservationScheduleOverride.count({ where: scope }), 0);
    });
    await t.test("other salon/tenant records and foreign staff cannot be selected", async () => {
      for (const key of ["other", "foreign"]) assert.equal((await move(known.id, baseInput, key)).statusCode, 404);
      for (const staffId of [otherStaff.id, foreignStaff.id, "missing"]) assert.equal((await move(known.id, { ...baseInput, staffId })).statusCode, 404);
      for (const invalid of [{ date: "2026-02-30" }, { startTime: "24:00" }, { expectedVersion: -1 }, { durationMinutes: 15 }]) assert.equal((await move(known.id, { ...baseInput, ...invalid })).statusCode, 400);
      assert.equal(await prisma.historicalReservationScheduleOverride.count({ where: scope }), 0);
    });
    await t.test("move preserves overnight duration, inactive staff and source snapshots", async () => {
      const response = await move(known.id); assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { id: known.id, startsAt: "2025-10-25T13:00:00.000Z", endsAt: "2025-10-25T14:30:00.000Z", rowId: alternate.id, staffName: alternate.name, scheduleVersion: 1 });
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal((await board("2025-10-25")).historicalReservations.find((card) => card.id === known.id)?.startTime, "22:00");
      assert.equal((await board("2025-10-25", alternate.name)).historicalReservations.length, 1);
      assert.equal((await board("2025-10-25", staff.name)).historicalReservations.length, 1);
      assert.deepEqual(await prisma.historicalReservation.findMany({ where: scope, orderBy: { id: "asc" } }), sources);
    });
    await t.test("two concurrent first moves return one success and one conflict, with no duplicate overlay", async () => {
      const responses = await Promise.all([
        move(racing.id, { ...baseInput, date: "2025-10-24", startTime: "12:00" }),
        move(racing.id, { ...baseInput, date: "2025-10-24", startTime: "13:00" })
      ]);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
      assert.equal(await prisma.historicalReservationScheduleOverride.count({ where: { historicalReservationId: racing.id } }), 1);
      assert.equal((await prisma.historicalReservationScheduleOverride.findUniqueOrThrow({ where: { historicalReservationId: racing.id } })).version, 1);
    });
    await t.test("concurrent stale moves do not overwrite a newer correction", async () => {
      const responses = await Promise.all([
        move(known.id, { ...baseInput, startTime: "21:00", expectedVersion: 1 }),
        move(known.id, { ...baseInput, startTime: "20:00", expectedVersion: 1 })
      ]);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
      assert.equal((await prisma.historicalReservationScheduleOverride.findUniqueOrThrow({ where: { historicalReservationId: known.id } })).version, 2);
      assert.equal((await move(known.id, baseInput)).statusCode, 409);
    });
    await t.test("effective date SQL excludes moved-out source days and orders moved-in cards", async () => {
      const response = await move(known.id, { ...baseInput, date: "2025-10-26", startTime: "09:00", staffId: null, expectedVersion: 2 });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await board("2025-10-25")).historicalReservations.some((card) => card.id === known.id), false);
      const card = (await board("2025-10-26")).historicalReservations[0];
      assert.equal(card.id, known.id); assert.equal(card.startTime, "09:00"); assert.equal(card.endTime, "10:30");
      assert.equal(card.rowId, "unassigned"); assert.equal(card.staffName, null); assert.equal(card.scheduleVersion, 3);
      const detail = await server.inject({ method: "GET", url: `/api/admin/reservation-history/${known.id}`, headers: { "x-test-context": "reader" } });
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(detail.json().startsAt, known.startsAt.toISOString());
      assert.equal(detail.json().staffId, staff.id);
      assert.equal(detail.json().scheduleOverride.startsAt, "2025-10-26T00:00:00.000Z");
      assert.equal(detail.json().scheduleOverride.scheduleVersion, 3);
      assert(!detail.body.includes("PRIVATE-SYNTHETIC-NOTE"));
    });
    await t.test("unknown end remains unknown and undo restores the prior effective placement using the returned version", async () => {
      const response = await move(unknown.id, { ...baseInput, startTime: "11:00" });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().endsAt, null);
      const moved = (await board("2025-10-25")).historicalReservations.find((card) => card.id === unknown.id)!;
      assert.equal(moved.endTime, null); assert.equal(moved.rowId, alternate.id);
      const undo = await move(unknown.id, { date: "2025-10-25", startTime: "10:00", staffId: staff.id, expectedVersion: response.json().scheduleVersion });
      assert.equal(undo.statusCode, 200, undo.body); assert.equal(undo.json().scheduleVersion, 2);
      assert.equal(undo.json().rowId, staff.id); assert.equal(undo.json().endsAt, null);
    });
    await t.test("override staff references prevent hard deletion and compound scope is protected in SQL", async () => {
      await move(unknown.id, { ...baseInput, expectedVersion: 2 });
      assert.equal(await staffScheduleDependencyCount(prisma, scope, alternate.id), 2);
      await assert.rejects(prisma.staff.delete({ where: { id: alternate.id } }), (error: any) => error.code === "P2003");
      await assert.rejects(prisma.historicalReservationScheduleOverride.update({ where: { historicalReservationId: known.id }, data: { staffId: otherStaff.id } }), (error: any) => error.code === "P2003");
    });
    await t.test("original data, operational data and permissions remain unchanged, with one audit per accepted move", async () => {
      assert.deepEqual(await prisma.historicalReservation.findMany({ where: scope, orderBy: { id: "asc" } }), sources);
      assert.deepEqual(await snapshot(), baseline);
      const audits = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: "reservation.history.schedule.move" } });
      assert.equal(audits.length, 7);
      assert(audits.every((audit) => audit.actorUserId === contexts.writer.user.id));
      assert(!JSON.stringify(audits).includes("Synthetic historical customer"));
      assert(!JSON.stringify(audits).includes("PRIVATE-SYNTHETIC"));
    });
  } finally {
    await server.close();
    if (tenantIds.length) {
      await prisma.historicalReservation.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
