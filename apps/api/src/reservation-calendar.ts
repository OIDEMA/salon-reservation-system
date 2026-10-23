import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { reservationPrice } from "./reservation-price.js";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine((value) => !value.startsWith("0000-"), "年月を確認してください。");
export const reservationCalendarQuerySchema = z.object({ month: monthSchema }).strict();
type Scope = { tenantId: string; salonId: string };

export type ReservationCalendar = {
  month: string;
  days: Array<{
    date: string;
    reservationCount: number;
    pendingCount: number;
    reservations: Array<{ id: string; startTime: string; customerName: string }>;
  }>;
  summary: { reservationCount: number; pendingCount: number; revenue: number; occupancyRate: number };
};

export function reservationCalendarBounds(value: string) {
  const month = monthSchema.parse(value);
  const [year, monthNumber] = month.split("-").map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const dayCount = monthNumber === 2 ? (leapYear ? 29 : 28) : ([4, 6, 9, 11].includes(monthNumber) ? 30 : 31);
  const start = new Date(`${month}-01T00:00:00.000+09:00`);
  return { month, start, end: new Date(start.getTime() + dayCount * 86_400_000), dayCount };
}

export function emptyReservationCalendar(month: string): ReservationCalendar {
  const { dayCount } = reservationCalendarBounds(month);
  return {
    month,
    days: Array.from({ length: dayCount }, (_, index) => ({
      date: `${month}-${String(index + 1).padStart(2, "0")}`,
      reservationCount: 0, pendingCount: 0, reservations: []
    })),
    summary: { reservationCount: 0, pendingCount: 0, revenue: 0, occupancyRate: 0 }
  };
}

const calendarSelect = {
  id: true, startsAt: true, endsAt: true, status: true,
  customer: { select: { name: true } },
  service: { select: { price: true } },
  memberBookingRequest: { select: { price: true } }
} satisfies Prisma.ReservationSelect;

/** Read every operational reservation in the selected JST month; only the day previews are limited. */
export async function reservationCalendar(database: Pick<PrismaClient, "reservation" | "salonSettings" | "staff">,
  scope: Scope, month: string): Promise<ReservationCalendar> {
  const { start, end, dayCount } = reservationCalendarBounds(month);
  const [reservations, settings, activeStaffCount] = await Promise.all([
    database.reservation.findMany({
      where: { ...scope, startsAt: { gte: start, lt: end } },
      select: calendarSelect,
      orderBy: [{ startsAt: "asc" }, { id: "asc" }]
    }),
    database.salonSettings.findUnique({
      where: { tenantId_salonId: scope }, select: { openTime: true, closeTime: true }
    }),
    database.staff.count({ where: { ...scope, active: true, role: { not: "ROOM_RESOURCE" } } })
  ]);
  const calendar = emptyReservationCalendar(month);
  const days = new Map(calendar.days.map((day) => [day.date, day]));
  let reservedMinutes = 0;
  for (const reservation of reservations) {
    const japanStart = new Date(reservation.startsAt.getTime() + 9 * 3_600_000).toISOString();
    const day = days.get(japanStart.slice(0, 10));
    if (!day) continue;
    day.reservationCount++;
    calendar.summary.reservationCount++;
    if (reservation.status === "PENDING") {
      day.pendingCount++;
      calendar.summary.pendingCount++;
    }
    if (day.reservations.length < 3) day.reservations.push({
      id: reservation.id, startTime: japanStart.slice(11, 16), customerName: reservation.customer.name
    });
    // Match the dashboard: all states contribute to revenue, while cancellations and no-shows do not occupy time.
    calendar.summary.revenue += reservationPrice(reservation);
    if (!["CANCELLED", "NO_SHOW"].includes(reservation.status)) {
      reservedMinutes += Math.max(0, (reservation.endsAt.getTime() - reservation.startsAt.getTime()) / 60_000);
    }
  }
  const toMinutes = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };
  const bookableMinutes = Math.max(0, toMinutes(settings?.closeTime ?? "20:00") - toMinutes(settings?.openTime ?? "09:00"))
    * activeStaffCount * dayCount;
  calendar.summary.occupancyRate = bookableMinutes > 0 ? Math.round(reservedMinutes / bookableMinutes * 100) : 0;
  return calendar;
}
