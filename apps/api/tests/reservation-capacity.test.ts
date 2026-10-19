import assert from "node:assert/strict";
import test from "node:test";
import { assertReservationCapacity, capacityReservationStatuses, peakConcurrentReservations, reservationCapacityProblem } from "../src/reservation-capacity.js";

const at = (hour: number, minute = 0) => new Date(Date.UTC(2035, 0, 1, hour, minute));
const input = { tenantId: "tenant", salonId: "salon", staffId: "staff", startsAt: at(9), endsAt: at(11) };
const interval = (start: number, end: number, staffId = "staff") => ({ startsAt: at(start), endsAt: at(end), staffId });
function database(options: { reservations?: ReturnType<typeof interval>[]; parallelCapacity?: number; salonCapacity?: number; shifts?: { staffId: string | null }[]; active?: boolean; accepting?: boolean } = {}) {
  const queries: Array<[string, any]> = [];
  const record = (name: string, result: unknown) => async (query: unknown) => { queries.push([name, query]); return result; };
  return {
    queries,
    db: {
      $queryRaw: record("lock", [{ id: "salon" }]),
      salonSettings: { findUnique: record("settings", { acceptingReservations: options.accepting ?? true, maxConcurrentReservations: options.salonCapacity ?? 10 }) },
      reservation: { findMany: record("reservations", options.reservations ?? []) },
      shift: { findMany: record("shifts", options.shifts ?? []) },
      staff: { findFirst: record("staff", options.active === false ? null : { parallelCapacity: options.parallelCapacity ?? 1 }) }
    } as any
  };
}

test("capacity measures simultaneous use, clips intervals and permits adjacent reservations", () => {
  assert.equal(peakConcurrentReservations([interval(8, 9), interval(11, 12)], at(9), at(11)), 0);
  assert.equal(peakConcurrentReservations([interval(8, 10), interval(10, 12)], at(9), at(11)), 1);
  assert.equal(peakConcurrentReservations([interval(8, 12), interval(9, 10), interval(10, 11)], at(9), at(11)), 2);
});

test("staff capacity permits non-simultaneous reservations but rejects simultaneous use", async () => {
  const adjacent = database({ reservations: [interval(9, 10), interval(10, 11)], parallelCapacity: 2 });
  assert.equal(await reservationCapacityProblem(adjacent.db, input), null);
  const busy = database({ reservations: [interval(9, 11), interval(9, 10)], parallelCapacity: 2 });
  assert.equal((await reservationCapacityProblem(busy.db, input))?.code, "STAFF_CONFLICT");
  const different = database({ reservations: [interval(9, 11, "other-staff")] });
  assert.equal(await reservationCapacityProblem(different.db, input), null);
});

test("salon capacity includes all staff and completed treatments retain their reserved interval", async () => {
  assert(capacityReservationStatuses.includes("COMPLETED"));
  assert(!capacityReservationStatuses.includes("CANCELLED"));
  assert(!capacityReservationStatuses.includes("NO_SHOW"));
  assert(!capacityReservationStatuses.includes("WAITLIST"));
  const busy = database({ reservations: [interval(9, 11, "other-staff")], salonCapacity: 1 });
  assert.equal((await reservationCapacityProblem(busy.db, input))?.code, "SALON_CAPACITY_EXCEEDED");
});

test("transactional final check locks before scoped reads and excludes the reservation being edited", async () => {
  const { db, queries } = database();
  await assertReservationCapacity(db, { ...input, excludeReservationId: "existing" });
  assert.equal(queries[0][0], "lock");
  const where = queries.find(([name]) => name === "reservations")![1].where;
  assert.equal(where.tenantId, input.tenantId); assert.equal(where.salonId, input.salonId);
  assert.deepEqual(where.id, { not: "existing" });
  assert.deepEqual(where.status.in, capacityReservationStatuses);
  const staffWhere = queries.find(([name]) => name === "staff")![1].where;
  assert.deepEqual(staffWhere, { id: "staff", tenantId: "tenant", salonId: "salon", active: true });
});

test("suspension, staff validation and schedule blocks fail closed", async () => {
  assert.equal((await reservationCapacityProblem(database({ accepting: false }).db, input))?.code, "RESERVATIONS_SUSPENDED");
  assert.equal((await reservationCapacityProblem(database({ active: false }).db, input))?.code, "INVALID_STAFF");
  assert.equal((await reservationCapacityProblem(database({ shifts: [{ staffId: null }] }).db, input))?.code, "SALON_UNAVAILABLE");
  assert.equal((await reservationCapacityProblem(database({ shifts: [{ staffId: "staff" }] }).db, input))?.code, "STAFF_UNAVAILABLE");
  assert.equal((await reservationCapacityProblem(database().db, { ...input, endsAt: at(9) }))?.code, "INVALID_RESERVATION_TIME");
  const missing = database(); missing.db.$queryRaw = async () => [];
  await assert.rejects(assertReservationCapacity(missing.db, input), { statusCode: 404, code: "SALON_NOT_FOUND" });
  assert.equal(missing.queries.length, 0);
});
