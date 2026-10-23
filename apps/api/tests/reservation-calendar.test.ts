import assert from "node:assert/strict";
import test from "node:test";
import { emptyReservationCalendar, reservationCalendar, reservationCalendarBounds, reservationCalendarQuerySchema } from "../src/reservation-calendar.js";
import { legacyPermission } from "../src/legacy-permissions.js";

const scope = { tenantId: "tenant-a", salonId: "salon-a" };
function record(id: string, startsAt: string, extra: Record<string, unknown> = {}) {
  const start = new Date(startsAt);
  return { ...scope, id, startsAt: start, endsAt: new Date(start.getTime() + 3_600_000),
    status: "CONFIRMED", customer: { name: `顧客${id}` }, service: { price: 1000 }, memberBookingRequest: null, ...extra };
}
function databaseFor(records: ReturnType<typeof record>[], options: {
  settings?: { openTime: string; closeTime: string } | null;
  staff?: Array<typeof scope & { active: boolean; role: string }>;
} = {}) {
  const reads: Record<string, any> = {};
  const settings = options.settings === undefined ? { openTime: "09:00", closeTime: "20:00" } : options.settings;
  const staff = options.staff ?? [{ ...scope, active: true, role: "STYLIST" }];
  const database = {
    reservation: { findMany: async (query: any) => {
      reads.reservations = query;
      let rows = records.filter((row) => row.tenantId === query.where.tenantId && row.salonId === query.where.salonId
        && row.startsAt >= query.where.startsAt.gte && row.startsAt < query.where.startsAt.lt)
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
      if (query.take !== undefined) rows = rows.slice(0, query.take);
      return rows;
    } },
    salonSettings: { findUnique: async (query: any) => { reads.settings = query; return settings; } },
    staff: { count: async (query: any) => {
      reads.staff = query;
      return staff.filter((row) => row.tenantId === query.where.tenantId && row.salonId === query.where.salonId
        && row.active === query.where.active && row.role !== query.where.role.not).length;
    } }
  } as any;
  return { database, reads };
}

test("calendar accepts only a complete valid month and retains reservation-read permission", () => {
  assert.deepEqual(reservationCalendarQuerySchema.parse({ month: "2026-10" }), { month: "2026-10" });
  for (const month of [undefined, "", "0000-01", "2026-1", "2026-00", "2026-13", "2026-10-01", " 2026-10", "2026-10 ", ["2026-10"], 202610]) {
    assert.equal(reservationCalendarQuerySchema.safeParse({ month }).success, false, String(month));
  }
  assert.equal(reservationCalendarQuerySchema.safeParse({ month: "2026-10", date: "2026-10-01" }).success, false);
  assert.equal(legacyPermission("GET", "/api/reservations/calendar"), "reservation.read");
});

test("month bounds use fixed JST boundaries, including leap years and the December year boundary", () => {
  const october = reservationCalendarBounds("2026-10");
  assert.equal(october.start.toISOString(), "2026-09-30T15:00:00.000Z");
  assert.equal(october.end.toISOString(), "2026-10-31T15:00:00.000Z");
  assert.equal(october.dayCount, 31);
  for (const [month, dayCount] of [["2024-02", 29], ["2026-02", 28], ["1900-02", 28], ["2000-02", 29]] as const) {
    assert.equal(reservationCalendarBounds(month).dayCount, dayCount);
  }
  assert.equal(reservationCalendarBounds("2026-12").end.toISOString(), "2026-12-31T15:00:00.000Z");
  assert.equal(reservationCalendarBounds("0001-01").start.toISOString(), "0000-12-31T15:00:00.000Z");
});

test("calendar scopes every read, includes month start, excludes next month start, and projects only required fields", async () => {
  const rows = [
    record("before", "2026-09-30T23:59:59.999+09:00"),
    record("start", "2026-10-01T00:00:00+09:00"),
    record("last", "2026-10-31T23:59:59.999+09:00", { status: "PENDING" }),
    record("after", "2026-11-01T00:00:00+09:00"),
    record("other-tenant", "2026-10-01T09:00:00+09:00", { tenantId: "tenant-b" }),
    record("other-salon", "2026-10-01T09:00:00+09:00", { salonId: "salon-b" })
  ];
  const { database, reads } = databaseFor(rows);
  const result = await reservationCalendar(database, scope, "2026-10");
  assert.equal(result.days.length, 31);
  assert.deepEqual(result.days[0].reservations, [{ id: "start", startTime: "00:00", customerName: "顧客start" }]);
  assert.equal(result.days[30].reservations[0].id, "last");
  assert.equal(result.days[30].pendingCount, 1);
  assert.deepEqual(result.days[1], { date: "2026-10-02", reservationCount: 0, pendingCount: 0, reservations: [] });
  assert.equal(result.summary.reservationCount, 2);
  assert.equal(result.summary.pendingCount, 1);
  assert.equal(result.summary.revenue, 2000);
  assert.deepEqual(reads.reservations.where, { ...scope, startsAt: {
    gte: new Date("2026-09-30T15:00:00Z"), lt: new Date("2026-10-31T15:00:00Z")
  } });
  assert.deepEqual(reads.reservations.select, {
    id: true, startsAt: true, endsAt: true, status: true,
    customer: { select: { name: true } }, service: { select: { price: true } }, memberBookingRequest: { select: { price: true } }
  });
  assert.deepEqual(reads.reservations.orderBy, [{ startsAt: "asc" }, { id: "asc" }]);
  assert.deepEqual(reads.settings, { where: { tenantId_salonId: scope }, select: { openTime: true, closeTime: true } });
  assert.deepEqual(reads.staff.where, { ...scope, active: true, role: { not: "ROOM_RESOURCE" } });
});

test("day previews retain the first three in time order while counts and revenue include more than 1000 reservations", async () => {
  const rows = Array.from({ length: 1005 }, (_, index) => record(`id-${String(index).padStart(4, "0")}`,
    "2026-10-13T10:00:00+09:00", { status: index % 2 === 0 ? "PENDING" : "CONFIRMED" }));
  rows.push(record("earlier", "2026-10-13T09:00:00+09:00"));
  const { database, reads } = databaseFor(rows.reverse());
  const result = await reservationCalendar(database, scope, "2026-10");
  assert.deepEqual(result.days[12].reservations.map((row) => row.id), ["earlier", "id-0000", "id-0001"]);
  assert.equal(result.days[12].reservationCount, 1006);
  assert.equal(result.days[12].pendingCount, 503);
  assert.equal(result.summary.reservationCount, 1006);
  assert.equal(result.summary.pendingCount, 503);
  assert.equal(result.summary.revenue, 1_006_000);
  assert.equal(result.summary.occupancyRate, Math.round(1006 * 60 / (11 * 60 * 31) * 100));
  assert.equal(reads.reservations.take, undefined);
  assert.equal(reads.reservations.skip, undefined);
});

test("monthly metrics retain agreed member prices, all-state revenue, and full cross-month durations", async () => {
  const rows = [
    record("ordinary", "2026-10-02T09:00:00+09:00"),
    record("member", "2026-10-03T09:00:00+09:00", { status: "PENDING", service: { price: 9000 }, memberBookingRequest: { price: 300 } }),
    record("free-member", "2026-10-04T09:00:00+09:00", { service: { price: 9000 }, memberBookingRequest: { price: 0 }, endsAt: new Date("2026-10-04T09:00:00+09:00") }),
    record("cancelled", "2026-10-05T09:00:00+09:00", { status: "CANCELLED", endsAt: new Date("2026-10-05T12:00:00+09:00") }),
    record("no-show", "2026-10-06T09:00:00+09:00", { status: "NO_SHOW", endsAt: new Date("2026-10-06T13:00:00+09:00") }),
    record("overnight", "2026-10-31T23:30:00+09:00", { endsAt: new Date("2026-11-01T01:30:00+09:00") }),
    record("negative-duration", "2026-10-07T10:00:00+09:00", { endsAt: new Date("2026-10-07T09:00:00+09:00") })
  ];
  const { database } = databaseFor(rows, { settings: { openTime: "09:00", closeTime: "10:00" }, staff: [
    { ...scope, active: true, role: "STYLIST" },
    { ...scope, active: false, role: "STYLIST" },
    { ...scope, active: true, role: "ROOM_RESOURCE" },
    { ...scope, salonId: "salon-b", active: true, role: "STYLIST" }
  ] });
  const result = await reservationCalendar(database, scope, "2026-10");
  assert.deepEqual(result.summary, { reservationCount: 7, pendingCount: 1, revenue: 5300, occupancyRate: 13 });
  assert.equal(result.days[30].reservations[0].startTime, "23:30");
});

test("empty stores and absent or non-positive capacity preserve zero occupancy", async () => {
  const empty = emptyReservationCalendar("2024-02");
  assert.equal(empty.days.length, 29);
  assert.equal(empty.days.at(-1)?.date, "2024-02-29");
  assert.deepEqual(empty.summary, { reservationCount: 0, pendingCount: 0, revenue: 0, occupancyRate: 0 });
  const rows = [record("one", "2026-10-01T09:00:00+09:00")];
  for (const options of [{ staff: [] }, { settings: { openTime: "20:00", closeTime: "09:00" } }]) {
    assert.equal((await reservationCalendar(databaseFor(rows, options).database, scope, "2026-10")).summary.occupancyRate, 0);
  }
  const defaults = await reservationCalendar(databaseFor(rows, { settings: null }).database, scope, "2026-10");
  assert.equal(defaults.summary.occupancyRate, Math.round(60 / (11 * 60 * 31) * 100));
});
