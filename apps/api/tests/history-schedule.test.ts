import assert from "node:assert/strict";
import test from "node:test";
import { historyScheduleInputSchema, moveHistoricalSchedule } from "../src/history-schedule.js";

test("historical moves validate actual calendar dates, clock time and optimistic version", () => {
  const valid = { date: "2026-10-15", startTime: "10:30", staffId: null, expectedVersion: 0 };
  assert.deepEqual(historyScheduleInputSchema.parse(valid), valid);
  for (const extra of [{ date: "2026-02-30" }, { startTime: "24:00" }, { startTime: "10:60" }, { expectedVersion: -1 }, { expectedVersion: 0.5 }, { staffId: "" }, { durationMinutes: 60 }]) {
    assert.equal(historyScheduleInputSchema.safeParse({ ...valid, ...extra }).success, false);
  }
});

test("historical moves preserve overnight duration and unknown end without inventing a duration", () => {
  const input = historyScheduleInputSchema.parse({ date: "2026-10-15", startTime: "23:45", staffId: null, expectedVersion: 0 });
  const previous = { startsAt: new Date("2025-10-14T23:30:00+09:00"), endsAt: new Date("2025-10-15T01:00:00+09:00"), staffId: "inactive-staff" };
  const moved = moveHistoricalSchedule(previous, input);
  assert.equal(moved.startsAt.toISOString(), "2026-10-15T14:45:00.000Z");
  assert.equal(moved.endsAt?.toISOString(), "2026-10-15T16:15:00.000Z");
  assert.equal(moved.staffId, null);
  assert.equal(moveHistoricalSchedule({ ...previous, endsAt: null }, input).endsAt, null);
  assert.throws(() => moveHistoricalSchedule({ ...previous, endsAt: previous.startsAt }, input));
  assert.equal(previous.startsAt.toISOString(), "2025-10-14T14:30:00.000Z");
});
