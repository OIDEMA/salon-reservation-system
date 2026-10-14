import assert from "node:assert/strict";
import test from "node:test";
import { dashboardQuerySchema, dashboardReservationWhere, japanDayBounds, historicalScheduleCard,
  dashboardHistory, HISTORICAL_DASHBOARD_LIMIT, dashboardScheduleRows, dashboardDisplayHours,
  staffScheduleDependencyCount } from "../src/dashboard-history.js";

const scope = { tenantId: "tenant-a", salonId: "salon-a" };
const day = japanDayBounds("2026-10-13");
function historyRecord(extra: Record<string, unknown> = {}) {
  return { id: "history-a", externalReservationId: "source-a", staffId: "legacy-a", source: "SALONBOARD",
    customerName: "履歴の顧客", customerKana: null, staffName: "過去の担当", sourceStatus: "会計済み",
    startsAt: new Date("2026-10-13T10:00:00+09:00"), endsAt: new Date("2026-10-13T11:00:00+09:00"),
    menuText: "脱毛", reservationAmount: null, nominated: false, ...extra } as any;
}

test("selected date is a valid Japan-local calendar day, regardless of host timezone", () => {
  assert.equal(day.start.toISOString(), "2026-10-12T15:00:00.000Z");
  assert.equal(day.end.toISOString(), "2026-10-13T15:00:00.000Z");
  assert.equal(day.end.getTime() - day.start.getTime(), 86_400_000);
  assert.equal(dashboardQuerySchema.safeParse({ date: "2026-02-29" }).success, false);
  assert.equal(dashboardQuerySchema.safeParse({ date: "2026-13-01" }).success, false);
  assert.equal(dashboardQuerySchema.safeParse({ q: "a".repeat(101) }).success, false);
  assert.equal(dashboardQuerySchema.safeParse({ q: "a\0b" }).success, false);
  assert.deepEqual(dashboardQuerySchema.parse({ date: "2024-02-29", q: "  検索  " }), { date: "2024-02-29", q: "検索", status: "ALL" });
});

test("operational search and status are applied in the scoped SQL query", () => {
  const where = dashboardReservationWhere(scope, day, { q: "対象", status: "CONFIRMED" });
  assert.equal(where.tenantId, "tenant-a");
  assert.equal(where.salonId, "salon-a");
  assert.deepEqual(where.startsAt, { gte: day.start, lt: day.end });
  assert.equal(where.status, "CONFIRMED");
  assert.equal((where.OR as any[]).length, 8);
  assert.deepEqual((where.OR as any[])[4], { staff: { name: { contains: "対象", mode: "insensitive" } } });
});

test("history reads one bounded day with a minimal projection and preserves every original source state", async () => {
  const statuses = ["会計済み", "サロンキャンセル", "お客様キャンセル", "受付待ち", "無断キャンセル"];
  let query: any;
  const records = statuses.map((sourceStatus, index) => historyRecord({ id: `history-${index}`, sourceStatus }));
  for (const record of records) Object.defineProperty(record, "rawValues", { get: () => { throw new Error("raw notes must not be read"); } });
  const database = { historicalReservation: { findMany: async (input: any) => { query = input; return records; } } } as any;
  const result = await dashboardHistory(database, scope, day, { q: "顧客", sourceStatus: "会計済み", status: "ALL" });
  assert.equal(query.where.tenantId, "tenant-a");
  assert.equal(query.where.salonId, "salon-a");
  assert.deepEqual(query.where.startsAt, { gte: day.start, lt: day.end });
  assert.equal(query.where.sourceStatus, "会計済み");
  assert.equal(query.take, HISTORICAL_DASHBOARD_LIMIT + 1);
  assert.deepEqual(query.orderBy, [{ startsAt: "asc" }, { id: "asc" }]);
  assert.equal(query.where.OR.length, 6);
  for (const privateField of ["rawHeaders", "rawValues", "customerNumber", "externalCustomerId"]) assert.equal(query.select[privateField], undefined);
  assert.deepEqual(result.historicalReservations.map((record) => record.sourceStatus), statuses);
  assert.equal(result.historicalReservations.every((record) => record.readOnly && record.rowId === "legacy-a"), true);
  assert.equal(result.historicalReservations.every((record) => record.reservationAmount === null), true);
  assert.equal(result.historicalHasMore, false);
});

test("a real operational status filter never guesses the equivalent SalonBoard state", async () => {
  const database = { historicalReservation: { findMany: async () => { throw new Error("must not query source state"); } } } as any;
  assert.deepEqual(await dashboardHistory(database, scope, day, { status: "COMPLETED" }), { historicalReservations: [], historicalHasMore: false });
});

test("a large day is capped with an explicit truncation flag", async () => {
  const records = Array.from({ length: HISTORICAL_DASHBOARD_LIMIT + 1 }, (_, index) => historyRecord({ id: `history-${index}` }));
  const database = { historicalReservation: { findMany: async () => records } } as any;
  const result = await dashboardHistory(database, scope, day, { status: "ALL" });
  assert.equal(result.historicalReservations.length, HISTORICAL_DASHBOARD_LIMIT);
  assert.equal(result.historicalHasMore, true);
});

test("cross-midnight source end times are retained and unknown ends or prices are not invented", () => {
  const overnight = historicalScheduleCard(historyRecord({ startsAt: new Date("2026-10-13T23:30:00+09:00"),
    endsAt: new Date("2026-10-14T01:00:00+09:00"), reservationAmount: 0 }), day.start);
  assert.equal(overnight.startTime, "23:30");
  assert.equal(overnight.endTime, "25:00");
  assert.equal(overnight.endsAt, "2026-10-13T16:00:00.000Z");
  assert.equal(overnight.reservationAmount, 0);
  const unknown = historicalScheduleCard(historyRecord({ staffId: null, endsAt: null, menuText: null }), day.start);
  assert.equal(unknown.rowId, "unassigned");
  assert.equal(unknown.endTime, null);
  assert.equal(unknown.endsAt, null);
  assert.equal(unknown.reservationAmount, null);
});

test("inactive staff appear only when referenced by the selected-day visual data", () => {
  const staff = [
    { id: "active-a", name: "現担当", role: "STYLIST", color: "#123456", active: true },
    { id: "legacy-a", name: "過去の担当", role: "STYLIST", color: "#234567", active: false },
    { id: "old-live", name: "既存予約の担当", role: "STYLIST", color: "#345678", active: false },
    { id: "old-shift", name: "休憩枠", role: "ROOM_RESOURCE", color: "#456789", active: false },
    { id: "unused", name: "未使用", role: "STYLIST", color: "#567890", active: false }
  ];
  const history = [historicalScheduleCard(historyRecord({ nominated: true }), day.start)];
  const rows = dashboardScheduleRows(staff, [{ staffId: "old-live", isRequest: false }], [{ staffId: "old-shift" }], history);
  assert.deepEqual(rows.map((row) => row.id), ["unassigned", "active-a", "legacy-a", "old-live", "old-shift"]);
  assert.equal(rows.find((row) => row.id === "legacy-a")?.active, false);
  assert.equal(rows.find((row) => row.id === "legacy-a")?.count, 1);
  assert.equal(rows.find((row) => row.id === "legacy-a")?.subtitle, "過去の担当 / 受付停止");
  assert.equal(rows.find((row) => row.id === "old-shift")?.type, "resource");
  assert.equal(rows.find((row) => row.id === "active-a")?.active, true);
});

test("the display window includes historic evenings without modifying business hours", () => {
  const businessHours = { start: "09:00", end: "20:00" };
  assert.deepEqual(dashboardDisplayHours(businessHours.start, businessHours.end,
    [{ startTime: "10:00", endTime: "21:00" }]), { start: "09:00", end: "21:00", stepMinutes: 30 });
  assert.deepEqual(dashboardDisplayHours(businessHours.start, businessHours.end,
    [{ startTime: "08:15", endTime: "25:00" }]), { start: "08:00", end: "25:00", stepMinutes: 30 });
  assert.deepEqual(dashboardDisplayHours(businessHours.start, businessHours.end,
    [{ startTime: "20:00", endTime: "20:30" }]), { start: "09:00", end: "21:00", stepMinutes: 30 });
  assert.deepEqual(businessHours, { start: "09:00", end: "20:00" });
});

test("a history-only staff dependency prevents hard deletion, scoped to its salon", async () => {
  const reads: Array<{ model: string; where: unknown }> = [];
  const count = (model: string, value: number) => ({ count: async ({ where }: any) => { reads.push({ model, where }); return value; } });
  const database = { reservation: count("reservation", 0), shift: count("shift", 0), historicalReservation: count("history", 7) } as any;
  assert.equal(await staffScheduleDependencyCount(database, scope, "legacy-a"), 7);
  assert.equal(reads.length, 3);
  assert.equal(reads.every((read) => JSON.stringify(read.where) === JSON.stringify({ ...scope, staffId: "legacy-a" })), true);
});
