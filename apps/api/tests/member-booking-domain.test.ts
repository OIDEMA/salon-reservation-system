import assert from "node:assert/strict";
import test from "node:test";
import type { SalonSettings } from "@prisma/client";
import {
  memberCreateSchema, publishedMemberTenants, memberPayloadHash, japanDateTime, memberBookingWindowDays,
  memberStartIsBookable, memberCanCancel, memberAvailabilitySlots, memberStaffIsWorking, isJapanPublicHoliday
} from "../src/member-booking-domain.js";
const settings = {
  acceptingReservations: true, bookingWindowType: "month", bookingWindowValue: "1ヶ月先", openTime: "09:00", closeTime: "20:00",
  closedDays: [], candidateIntervalMinutes: 30, maxConcurrentReservations: 2,
  reservationCutoffMode: "previous_day", reservationCutoffDays: 1, reservationCutoffTime: "21:30", reservationCutoffHours: 0,
  cancellationCutoffMode: "previous_day", cancellationCutoffDays: 1, cancellationCutoffTime: "21:30", cancellationCutoffHours: 0
} as unknown as SalonSettings;
const now = japanDateTime("2026-10-19", "10:00");
const starts = japanDateTime("2026-10-21", "10:00"); const ends = japanDateTime("2026-10-21", "11:00");
const staff = { id: "staff", name: "担当", active: true, role: "ESTHETICIAN" as const, nominationFee: 500, parallelCapacity: 1 };
const shift = { staffId: staff.id, type: "AVAILABLE" as const, startsAt: japanDateTime("2026-10-21", "09:00"), endsAt: japanDateTime("2026-10-21", "20:00") };

test("publication is explicit, bounded and fails closed for malformed or duplicate mappings", () => {
  assert.equal(publishedMemberTenants("").size, 0);
  assert.deepEqual([...publishedMemberTenants("mens-gentle:gentle;missmrs-takamatsu:missmrs")], [["mens-gentle", "gentle"], ["missmrs-takamatsu", "missmrs"]]);
  for (const value of ["other:unknown", "salon:gentle;salon:missmrs", "all:*", "salon:gentle;"]) assert.equal(publishedMemberTenants(value).size, 0);
});
test("untrusted amount, customer identifiers, state and UID cannot be submitted", () => {
  const input = { salonId: "s", serviceId: "m", staffId: "t", expectedPrice: 9800, expectedDurationMinutes: 60, date: "2026-10-21", startTime: "10:00", customer: { name: "会員", kana: "カイイン", phone: "090-1234-5678" } };
  const parsed = memberCreateSchema.parse(input);
  for (const field of ["price", "customerId", "status", "uid", "paymentStatus", "durationMinutes", "tenantId"]) assert(!memberCreateSchema.safeParse({ ...input, [field]: "forged" }).success);
  assert(!memberCreateSchema.safeParse({ ...input, customer: { ...input.customer, id: "foreign" } }).success);
  assert(!memberCreateSchema.safeParse({ ...input, customer: { ...input.customer, phone: "----------" } }).success);
  assert.equal(memberPayloadHash(parsed), memberPayloadHash(memberCreateSchema.parse(input)));
  assert.notEqual(memberPayloadHash(parsed), memberPayloadHash({ ...parsed, startTime: "11:00" }));
});
test("JST dates and times reject invalid calendar days and overflowing times", () => {
  assert.equal(japanDateTime("2026-10-21", "10:00").toISOString(), "2026-10-21T01:00:00.000Z");
  for (const [date, time] of [["2026-02-30", "10:00"], ["2026-13-01", "10:00"], ["2026-10-21", "25:00"]]) assert.throws(() => japanDateTime(date, time));
});
test("booking respects calendar horizon, hours, intervals, close days, suspension and cutoff", () => {
  assert.equal(memberBookingWindowDays(settings, now), 31);
  assert.equal(memberBookingWindowDays({ ...settings, bookingWindowValue: "不明" }, now), 0);
  assert.equal(memberBookingWindowDays({ ...settings, bookingWindowValue: "2週間先" }, now), 14);
  assert(memberStartIsBookable(settings, starts, 60, now));
  for (const config of [{ ...settings, acceptingReservations: false }, { ...settings, closedDays: ["水"] },
    { ...settings, reservationCutoffDays: 10 }, { ...settings, openTime: "11:00" }, { ...settings, closeTime: "10:30" }]) assert(!memberStartIsBookable(config, starts, 60, now));
  assert(!memberStartIsBookable(settings, japanDateTime("2026-10-21", "10:15"), 60, now));
  assert(!memberStartIsBookable(settings, japanDateTime("2026-12-21", "10:00"), 60, now));
  assert(!memberStartIsBookable(settings, starts, 60, japanDateTime("2026-10-20", "21:30")));
});
test("holiday closure includes substitute days and weekday between holidays", () => {
  assert(isJapanPublicHoliday("2026-11-03")); assert(isJapanPublicHoliday("2027-01-11"));
  assert(isJapanPublicHoliday("2026-05-06")); assert(isJapanPublicHoliday("2026-09-22"));
  assert(!isJapanPublicHoliday("2026-10-21"));
});
// Cabinet Office published calendar, checked 2026-10-19:
// https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
test("holiday calculation matches every day of the official 2026 and 2027 calendars", () => {
  const official = new Set([
    "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
    "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23"
  ]);
  for (let value = Date.UTC(2026, 0, 1); value < Date.UTC(2028, 0, 1); value += 86_400_000) {
    const date = new Date(value).toISOString().slice(0, 10); assert.equal(isJapanPublicHoliday(date), official.has(date), date);
  }
});
test("staff must have covering AVAILABLE shifts and no salon/staff nonworking block", () => {
  assert(memberStaffIsWorking(staff, [shift], starts, ends)); assert(!memberStaffIsWorking(staff, [], starts, ends));
  assert(!memberStaffIsWorking({ ...staff, active: false }, [shift], starts, ends));
  assert(!memberStaffIsWorking({ ...staff, role: "ROOM_RESOURCE" }, [shift], starts, ends));
  assert(!memberStaffIsWorking(staff, [shift, { ...shift, type: "TRAINING", startsAt: starts, endsAt: ends }], starts, ends));
  assert(!memberStaffIsWorking(staff, [shift, { ...shift, staffId: null, type: "SALES_STOP", startsAt: starts, endsAt: ends }], starts, ends));
  assert(memberStaffIsWorking(staff, [{ ...shift, endsAt: japanDateTime("2026-10-21", "10:30") }, { ...shift, startsAt: japanDateTime("2026-10-21", "10:30") }], starts, ends));
});
test("availability computes price, uses touching endpoints and checks both staff and salon peaks", () => {
  const menu = { id: "menu", durationMinutes: 60, price: 9800 };
  const slots = memberAvailabilitySlots("salon", menu, settings, [staff], [shift], [{ staffId: staff.id, startsAt: japanDateTime("2026-10-21", "09:00"), endsAt: starts }], "2026-10-21", now);
  const ten = slots.find((slot) => slot.startTime === "10:00"); assert(ten); assert.equal(ten.price, 10300); assert.equal(ten.durationMinutes, 60);
  assert(!slots.some((slot) => slot.startTime === "09:30"));
  const noShift = memberAvailabilitySlots("salon", menu, settings, [staff], [], [], "2026-10-21", now); assert.equal(noShift.length, 0);
  const full = memberAvailabilitySlots("salon", menu, settings, [staff], [shift], [{ staffId: "a", startsAt: starts, endsAt: ends }, { staffId: "b", startsAt: starts, endsAt: ends }], "2026-10-21", now);
  assert(!full.some((slot) => slot.startTime === "10:00"));
});
test("online cancellation requires unpaid pending/confirmed/waitlist and precedes cutoff", () => {
  const reservation = { status: "CONFIRMED", paymentStatus: "UNPAID", startsAt: starts };
  assert(memberCanCancel(reservation, settings, now));
  for (const status of ["CANCELLED", "COMPLETED", "ARRIVED", "NO_SHOW"]) assert(!memberCanCancel({ ...reservation, status }, settings, now));
  for (const paymentStatus of ["AUTHORIZED", "PAID", "REFUNDED"]) assert(!memberCanCancel({ ...reservation, paymentStatus }, settings, now));
  assert(!memberCanCancel(reservation, null, now)); assert(!memberCanCancel(reservation, settings, japanDateTime("2026-10-20", "21:30")));
});
