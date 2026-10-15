import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const databaseUrl = process.env.DASHBOARD_HISTORY_TEST_DATABASE_URL ?? process.env.OPERATIONS_TEST_DATABASE_URL;
test("the staff board shows scoped historical cards without changing operational data or metrics", { skip: !databaseUrl }, async (t) => {
  const target = new URL(databaseUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = databaseUrl;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")
  ]);
  server.log.level = "silent";
  const prefix = `history-board-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const identities = new Map<string, { uid: string; email: string; email_verified: boolean }>();
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    const claims = identities.get(credential); assert(claims); return claims;
  });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "Synthetic board tenant" } }); tenantIds.push(tenant.id);
    const foreignTenant = await prisma.tenant.create({ data: { slug: `${prefix}-other`, name: "Synthetic other tenant" } }); tenantIds.push(foreignTenant.id);
    const otherSalon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic other salon", createdAt: new Date("2020-01-01T00:00:00Z") } });
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Synthetic permitted salon" } });
    const foreignSalon = await prisma.salon.create({ data: { tenantId: foreignTenant.id, name: "Synthetic foreign salon" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    await prisma.salonSettings.create({ data: { ...scope, storeId: `${prefix}-store`, openTime: "09:00", closeTime: "20:00",
      cancellationMessage: "Synthetic cancellation message", friendMessage: "Synthetic friend message" } });
    async function account(key: string, permissions: string[]) {
      const uid = `${prefix}-${key}`;
      identities.set(uid, { uid, email: `${uid}@example.test`, email_verified: true });
      const user = await prisma.appUser.create({ data: { firebaseUid: uid, email: `${uid}@example.test` } }); userIds.push(user.id);
      await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: "STAFF", useCustomPermissions: true, permissions, salonIds: [salon.id] } });
      return { authorization: `Bearer ${uid}`, "x-tenant-slug": tenant.slug, "x-salon-id": salon.id };
    }
    const reader = await account("reader", ["reservation.read"]);
    const writer = await account("writer", ["reservation.write", "master.write"]);
    const denied = await account("denied", ["customer.read"]);
    const active = await prisma.staff.create({ data: { ...scope, name: "Synthetic current staff", kana: "CURRENT", role: "ESTHETICIAN", color: "#111111", active: true } });
    const historical = await prisma.staff.create({ data: { ...scope, name: "Synthetic historical staff", kana: "HISTORICAL", role: "ESTHETICIAN", color: "#222222", active: false, sortOrder: 100 } });
    const unused = await prisma.staff.create({ data: { ...scope, name: "Synthetic unused inactive", kana: "UNUSED", role: "ESTHETICIAN", color: "#333333", active: false } });
    const customer = await prisma.customer.create({ data: { ...scope, name: "Synthetic operational customer", kana: "OPERATIONAL", visitCount: 9, totalSpent: 12345, lastVisitAt: new Date("2026-09-01T00:00:00Z") } });
    const service = await prisma.service.create({ data: { ...scope, name: "Synthetic operational service", category: "Synthetic", durationMinutes: 30, price: 1000, color: "#111111" } });
    const operation = await prisma.reservation.create({ data: { ...scope, customerId: customer.id, staffId: active.id, serviceId: service.id,
      startsAt: new Date("2026-10-13T10:00:00+09:00"), endsAt: new Date("2026-10-13T10:30:00+09:00"),
      status: "PENDING", lineMessageStatus: "READ", riskScore: 60 } });
    const confirmed = await prisma.reservation.create({ data: { ...scope, customerId: customer.id, staffId: active.id, serviceId: service.id,
      startsAt: new Date("2026-10-13T11:00:00+09:00"), endsAt: new Date("2026-10-13T11:30:00+09:00"), status: "CONFIRMED" } });
    const states = ["会計済み", "サロンキャンセル", "お客様キャンセル", "受付待ち", "無断キャンセル"];
    const histories = [];
    for (const [index, sourceStatus] of states.entries()) histories.push(await prisma.historicalReservation.create({ data: {
      ...scope, staffId: historical.id, source: "SALONBOARD", sourceStoreId: "H000551123", externalReservationId: `${prefix}-source-${index}`,
      customerName: `Synthetic history customer ${index}`, staffName: "Synthetic source name", sourceStatus,
      startsAt: new Date(`2026-10-13T${index === 4 ? "20:30" : `1${index}:00`}:00+09:00`),
      endsAt: new Date(`2026-10-13T${index === 4 ? "21:00" : `1${index}:30`}:00+09:00`),
      menuText: "Synthetic historic service", reservationAmount: index ? null : 999999,
      rawHeaders: ["メモ", "支払い"], rawValues: ["PRIVATE-SYNTHETIC-CHART-NOTE", "PRIVATE-SYNTHETIC-PAYMENT-DETAIL"], capturedAt: new Date("2026-10-14T00:00:00Z")
    } }));
    // Same-day foreign rows and exact next-day boundary must never leak into this board.
    for (const [index, foreignScope] of [{ tenantId: tenant.id, salonId: otherSalon.id }, { tenantId: foreignTenant.id, salonId: foreignSalon.id }, scope].entries()) {
      await prisma.historicalReservation.create({ data: { ...foreignScope, source: "SALONBOARD", sourceStoreId: "H000551123", externalReservationId: `${prefix}-excluded-${index}`,
        customerName: "EXCLUDED-SYNTHETIC-HISTORY", sourceStatus: "会計済み", startsAt: new Date(index === 2 ? "2026-10-14T00:00:00+09:00" : "2026-10-13T10:00:00+09:00"),
        rawHeaders: [], rawValues: [], capturedAt: new Date("2026-10-14T00:00:00Z") } });
    }
    const operationsSnapshot = async () => ({
      reservations: await prisma.reservation.findMany({ where: scope, orderBy: { id: "asc" } }),
      customers: await prisma.customer.findMany({ where: scope, orderBy: { id: "asc" } }),
      shifts: await prisma.shift.findMany({ where: scope }),
      notifications: await prisma.notification.findMany({ where: scope }),
      checkouts: await prisma.cashCheckout.count({ where: scope }),
      registerSessions: await prisma.cashRegisterSession.count({ where: scope }),
      charts: await prisma.treatmentChart.count({ where: scope })
    });
    const baseline = await operationsSnapshot();
    const get = (query = "", headers = reader) => server.inject({ method: "GET", url: `/api/dashboard?date=2026-10-13${query ? `&${query}` : ""}`, headers });
    let originalSummary: unknown;
    await t.test("historical states and inactive assigned rows are visible, with no chart/payment payload", async () => {
      const response = await get(); assert.equal(response.statusCode, 200, response.body);
      const board = response.json(); originalSummary = board.summary;
      assert.equal(board.reservations.length, 2);
      assert.deepEqual(new Set(board.reservations.map((record: any) => record.id)), new Set([operation.id, confirmed.id]));
      assert.equal(board.historicalReservations.length, 5, JSON.stringify(board.historicalReservations.map((card: any) => ({ id: card.id, startsAt: card.startsAt, sourceStatus: card.sourceStatus }))));
      assert.deepEqual(board.historicalReservations.map((record: any) => record.sourceStatus), states);
      assert(board.historicalReservations.every((record: any) => record.readOnly && record.rowId === historical.id));
      assert.equal(board.historicalHasMore, false);
      assert.equal(board.rows.find((row: any) => row.id === historical.id)?.active, false);
      assert.equal(board.rows.find((row: any) => row.id === historical.id)?.count, 5);
      assert(!board.rows.some((row: any) => row.id === unused.id));
      assert.equal(board.hours.end, "21:00");
      assert(!response.body.includes("EXCLUDED-SYNTHETIC")); assert(!response.body.includes("PRIVATE-SYNTHETIC"));
      assert.equal(board.summary.revenue, 2000); assert.equal(board.summary.pendingCount, 1);
      assert.equal(board.summary.confirmedCount, 1); assert.equal(board.summary.occupancyRate, 9);
      assert.equal(board.summary.averageTicket, 1000); assert.equal(board.summary.lineReadRate, 100);
    });
    await t.test("API search and status filter the selected-day cards while full-day operational metrics stay unchanged", async () => {
      const searched = (await get(`q=${encodeURIComponent(`${prefix}-source-2`)}`)).json();
      assert.equal(searched.reservations.length, 0); assert.equal(searched.historicalReservations.length, 1);
      assert.equal(searched.historicalReservations[0].id, histories[2].id); assert.deepEqual(searched.summary, originalSummary);
      const status = (await get("status=PENDING")).json();
      assert.deepEqual(status.reservations.map((record: any) => record.id), [operation.id]);
      assert.deepEqual(status.historicalReservations, []); assert.deepEqual(status.summary, originalSummary);
      const literal = (await get(`sourceStatus=${encodeURIComponent("お客様キャンセル")}`)).json();
      assert.deepEqual(literal.historicalReservations.map((record: any) => record.id), [histories[2].id]);
      const noNotes = (await get("q=PRIVATE-SYNTHETIC")).json();
      assert.deepEqual(noNotes.historicalReservations, []); assert.deepEqual(noNotes.summary, originalSummary);
    });
    await t.test("read authorization, salon scope, and query bounds are enforced", async () => {
      assert.equal((await get("", denied)).statusCode, 403);
      assert.equal((await get("", { ...reader, "x-salon-id": otherSalon.id })).statusCode, 403);
      for (const query of ["date=2026-02-30", "status=INVALID", `q=${"a".repeat(101)}`]) {
        const response = await server.inject({ method: "GET", url: `/api/dashboard?${query}`, headers: reader });
        assert.equal(response.statusCode, 400, query);
      }
    });
    await t.test("operational mutation routes cannot change a historical reservation", async () => {
      const response = await server.inject({ method: "PATCH", url: `/api/reservations/${histories[0].id}/status`, headers: writer, payload: { status: "CANCELLED" } });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal((await prisma.historicalReservation.findUniqueOrThrow({ where: { id: histories[0].id } })).sourceStatus, "会計済み");
      assert.deepEqual(await operationsSnapshot(), baseline);
      assert.equal((await prisma.salonSettings.findUniqueOrThrow({ where: { tenantId_salonId: scope } })).closeTime, "20:00");
    });
    await t.test("deleting a history-only staff row retains the relation and stops受付", async () => {
      const response = await server.inject({ method: "DELETE", url: `/api/admin/staff/${historical.id}`, headers: writer });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { deleted: false, deactivated: true });
      assert.equal((await prisma.staff.findUniqueOrThrow({ where: { id: historical.id } })).active, false);
      assert.equal(await prisma.historicalReservation.count({ where: { ...scope, staffId: historical.id } }), 5);
    });
  } finally {
    await server.close(); auth.mock.restore();
    if (tenantIds.length) {
      // Remove fixture references before the restrictive history-staff relation.
      await prisma.historicalReservation.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
