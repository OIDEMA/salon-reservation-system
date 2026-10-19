import { createHash } from "node:crypto";
import type { SalonSettings, Shift, Staff } from "@prisma/client";
import { z } from "zod";
import { peakConcurrentReservations } from "./reservation-capacity.js";

export const MEMBER_PROJECT_ID = "salon-reserve-bg";
export const PAYMENT_MODE = "pay_at_salon" as const;
export const MAX_FUTURE_MEMBER_RESERVATIONS = 8;
export const MEMBER_BOOKING_ATTEMPTS_PER_TEN_MINUTES = 10;
export type MemberIdentity = { projectId: string; uid: string };
export type MemberBrand = "gentle" | "missmrs" | "antiage";
export class MemberBookingError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); this.name = "MemberBookingError"; }
}
export const memberError = (statusCode: number, code: string, message: string) => new MemberBookingError(statusCode, code, message);
const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const cleanText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "使用できない文字があります。");
export const memberCreateSchema = z.object({
  salonId: identifier, serviceId: identifier, staffId: identifier,
  expectedPrice: z.number().int().min(0).max(110_000_000), expectedDurationMinutes: z.number().int().positive().max(24 * 60),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  customer: z.object({ name: cleanText(1, 100), kana: cleanText(1, 100), phone: z.string().trim().regex(/^[+\d() -]{8,30}$/).refine((value) => { const digits = value.replace(/\D/g, ""); return digits.length >= 10 && digits.length <= 15; }, "電話番号を確認してください。") }).strict()
}).strict();
export const memberAvailabilitySchema = memberCreateSchema.pick({ salonId: true, serviceId: true, date: true }).extend({ staffId: identifier.optional() }).strict();
export const memberPageSchema = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const idempotencyKeySchema = z.string().uuid();
export type MemberCreateInput = z.infer<typeof memberCreateSchema>;

/** Explicit publication list. Any malformed or duplicated entry fails closed. */
export function publishedMemberTenants(value = process.env.MEMBER_BOOKING_TENANTS ?? ""): Map<string, MemberBrand> {
  const result = new Map<string, MemberBrand>();
  if (!value.trim()) return result;
  const entries = value.split(";");
  if (entries.length > 20) return new Map();
  for (const entry of entries) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*):(gentle|missmrs|antiage)$/.exec(entry.trim());
    if (!match || result.has(match[1])) return new Map();
    result.set(match[1], match[2] as MemberBrand);
  }
  return result;
}
export function memberPayloadHash(input: MemberCreateInput): string {
  return createHash("sha256").update(JSON.stringify([input.salonId, input.serviceId, input.staffId, input.date, input.startTime,
    input.customer.name, input.customer.kana, input.customer.phone, input.expectedPrice, input.expectedDurationMinutes])).digest("hex");
}
export function japanDate(value: Date): string { return new Date(value.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10); }
export function japanTime(value: Date): string { return new Date(value.getTime() + 9 * 60 * 60_000).toISOString().slice(11, 16); }
export function japanDateTime(date: string, time = "00:00"): Date {
  const value = new Date(`${date}T${time}:00+09:00`);
  if (!Number.isFinite(value.getTime()) || japanDate(value) !== date || japanTime(value) !== time) {
    throw memberError(400, "INVALID_DATE", "日付と時刻を確認してください。");
  }
  return value;
}
const dayMillis = 86_400_000;
const minuteValue = (value: string) => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes;
};
const minuteTime = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
export function memberBookingWindowDays(settings: SalonSettings, now: Date): number {
  const value = settings.bookingWindowValue.normalize("NFKC").trim();
  const match = /^(\d{1,3})\s*(ヶ月|か月|ケ月|月|週間|週|日)?(?:先|以内)?$/.exec(value);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!amount) return 0;
  const unit = match[2] ?? settings.bookingWindowType;
  if (["ヶ月", "か月", "ケ月", "月", "month"].includes(unit)) {
    const current = japanDateTime(japanDate(now));
    const calendar = new Date(`${japanDate(now)}T00:00:00Z`);
    const lastDay = new Date(Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth() + amount + 1, 0)).getUTCDate();
    const target = new Date(Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth() + amount, Math.min(calendar.getUTCDate(), lastDay)));
    return Math.min(180, Math.max(0, Math.round((japanDateTime(target.toISOString().slice(0, 10)).getTime() - current.getTime()) / dayMillis)));
  }
  return Math.min(180, Math.max(0, amount * (["週間", "週", "week"].includes(unit) ? 7 : 1)));
}
function cutoffAt(settings: SalonSettings, startsAt: Date, kind: "reservation" | "cancellation"): Date | null {
  const mode = settings[`${kind}CutoffMode`];
  if (["hours", "hours_before", "hours_before_start"].includes(mode)) {
    const hours = settings[`${kind}CutoffHours`];
    return Number.isFinite(hours) && hours >= 0 ? new Date(startsAt.getTime() - hours * 3_600_000) : null;
  }
  if (!["previous_day", "days_before", "same_day"].includes(mode)) return null;
  const days = mode === "same_day" ? 0 : settings[`${kind}CutoffDays`];
  const time = settings[`${kind}CutoffTime`];
  if (!Number.isInteger(days) || days < 0 || minuteValue(time) === null) return null;
  const date = japanDate(new Date(startsAt.getTime() - days * dayMillis));
  return new Date(Math.min(startsAt.getTime(), japanDateTime(date, time).getTime()));
}

/** Modern Japanese public holiday rules, used only for bounded future dates.
 * Official 2026/2027 calendars: https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
 */
export function isJapanPublicHoliday(date: string): boolean {
  const calendar = new Date(`${date}T00:00:00Z`); const year = calendar.getUTCFullYear();
  if (year < 2022 || year > 2099) return true; // Unverified holiday calendar fails closed.
  const day = (month: number, date: number) => new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10);
  const nthMonday = (month: number, nth: number) => {
    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); return 1 + (8 - firstWeekday) % 7 + (nth - 1) * 7;
  };
  const holidays = new Set([day(1, 1), day(1, nthMonday(1, 2)), day(2, 11), day(2, 23),
    day(3, Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))), day(4, 29), day(5, 3), day(5, 4), day(5, 5),
    day(7, nthMonday(7, 3)), day(8, 11), day(9, nthMonday(9, 3)),
    day(9, Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))), day(10, nthMonday(10, 2)), day(11, 3), day(11, 23)]);
  // A weekday between national holidays is also a holiday (e.g. Silver Week).
  for (let value = Date.UTC(year, 0, 2); value < Date.UTC(year + 1, 0, 1); value += dayMillis) {
    const current = new Date(value).toISOString().slice(0, 10);
    if (holidays.has(new Date(value - dayMillis).toISOString().slice(0, 10)) && holidays.has(new Date(value + dayMillis).toISOString().slice(0, 10))) holidays.add(current);
  }
  for (const holiday of [...holidays].sort()) {
    let current = new Date(`${holiday}T00:00:00Z`);
    if (current.getUTCDay() !== 0) continue;
    do { current = new Date(current.getTime() + dayMillis); } while (holidays.has(current.toISOString().slice(0, 10)));
    holidays.add(current.toISOString().slice(0, 10));
  }
  return holidays.has(date);
}
export function memberDayIsOpen(settings: SalonSettings, date: string): boolean {
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][new Date(`${date}T00:00:00Z`).getUTCDay()];
  return !settings.closedDays.includes(weekday) && !(settings.closedDays.includes("祝") && isJapanPublicHoliday(date));
}
export function memberStartIsBookable(settings: SalonSettings, startsAt: Date, durationMinutes: number, now: Date): boolean {
  const date = japanDate(startsAt); const day = japanDateTime(date); const today = japanDateTime(japanDate(now));
  const distance = Math.round((day.getTime() - today.getTime()) / dayMillis);
  const start = minuteValue(japanTime(startsAt)); const open = minuteValue(settings.openTime); const close = minuteValue(settings.closeTime);
  const cutoff = cutoffAt(settings, startsAt, "reservation");
  return settings.acceptingReservations && startsAt > now && distance >= 0 && distance <= memberBookingWindowDays(settings, now) &&
    memberDayIsOpen(settings, date) && start !== null && open !== null && close !== null && close > open &&
    Number.isInteger(durationMinutes) && durationMinutes > 0 && start >= open && start + durationMinutes <= close &&
    settings.candidateIntervalMinutes >= 5 && settings.candidateIntervalMinutes <= 240 && (start - open) % settings.candidateIntervalMinutes === 0 &&
    cutoff !== null && now < cutoff;
}
export function memberCanCancel(reservation: { status: string; paymentStatus: string; startsAt: Date }, settings: SalonSettings | null, now: Date): boolean {
  if (!settings || !["PENDING", "CONFIRMED", "WAITLIST"].includes(reservation.status) || reservation.paymentStatus !== "UNPAID" || reservation.startsAt <= now) return false;
  const cutoff = cutoffAt(settings, reservation.startsAt, "cancellation");
  return cutoff !== null && now < cutoff;
}
export type MemberWorkingStaff = Pick<Staff, "id" | "name" | "active" | "role" | "nominationFee" | "parallelCapacity">;
export type MemberShift = Pick<Shift, "staffId" | "type" | "startsAt" | "endsAt">;
export type MemberBusyReservation = { staffId: string | null; startsAt: Date; endsAt: Date };
export function memberStaffIsWorking(staff: MemberWorkingStaff, shifts: MemberShift[], startsAt: Date, endsAt: Date): boolean {
  if (!staff.active || staff.role === "ROOM_RESOURCE") return false;
  const available = shifts.filter((shift) => shift.type === "AVAILABLE" && shift.staffId === staff.id)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  let through = startsAt.getTime();
  for (const shift of available) {
    if (shift.startsAt.getTime() > through) break;
    if (shift.endsAt.getTime() > through) through = shift.endsAt.getTime();
  }
  if (through < endsAt.getTime()) return false;
  return !shifts.some((shift) => (shift.staffId === null || shift.staffId === staff.id) &&
    ["OFF", "BREAK", "SALES_STOP", "TRAINING"].includes(shift.type) && shift.startsAt < endsAt && shift.endsAt > startsAt);
}
export function memberSlotIsAvailable(settings: SalonSettings, staff: MemberWorkingStaff, shifts: MemberShift[], busy: MemberBusyReservation[], startsAt: Date, endsAt: Date): boolean {
  return memberStaffIsWorking(staff, shifts, startsAt, endsAt) &&
    peakConcurrentReservations(busy, startsAt, endsAt) < settings.maxConcurrentReservations &&
    peakConcurrentReservations(busy.filter((reservation) => reservation.staffId === staff.id), startsAt, endsAt) < staff.parallelCapacity;
}
export function memberAvailabilitySlots(salonId: string, service: { id: string; durationMinutes: number; price: number }, settings: SalonSettings,
  staff: MemberWorkingStaff[], shifts: MemberShift[], busy: MemberBusyReservation[], date: string, now: Date) {
  const open = minuteValue(settings.openTime); const close = minuteValue(settings.closeTime);
  const slots: { id: string; startTime: string; endTime: string; startsAt: string; endsAt: string; staffId: string; staffName: string; price: number; durationMinutes: number }[] = [];
  if (open === null || close === null || close <= open || settings.candidateIntervalMinutes < 5 || settings.candidateIntervalMinutes > 240) return slots;
  for (let minute = open; minute + service.durationMinutes <= close; minute += settings.candidateIntervalMinutes) {
    const startsAt = japanDateTime(date, minuteTime(minute)); const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
    if (!memberStartIsBookable(settings, startsAt, service.durationMinutes, now)) continue;
    for (const member of staff) {
      if (!memberSlotIsAvailable(settings, member, shifts, busy, startsAt, endsAt)) continue;
      slots.push({ id: createHash("sha256").update(JSON.stringify([salonId, service.id, member.id, startsAt.toISOString()])).digest("hex").slice(0, 32),
        startTime: japanTime(startsAt), endTime: japanTime(endsAt), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
        staffId: member.id, staffName: member.name, price: service.price + member.nominationFee, durationMinutes: service.durationMinutes });
    }
  }
  return slots;
}
