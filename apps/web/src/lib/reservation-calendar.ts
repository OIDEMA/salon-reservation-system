import { dashboardToday } from "./dashboard-preload";

export type ReservationCalendarData = {
  month: string;
  days: Array<{
    date: string;
    reservationCount: number;
    pendingCount: number;
    reservations: Array<{ id: string; startTime: string; customerName: string }>;
  }>;
  summary: {
    reservationCount: number;
    pendingCount: number;
    revenue: number;
    occupancyRate: number;
  };
};

function validMonth(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) > 0);
}

export function calendarMonth(value?: string | string[], now = new Date()) {
  const month = Array.isArray(value) ? value[0] : value;
  return validMonth(month) ? month : dashboardToday(now).slice(0, 7);
}

export function adjacentCalendarMonth(month: string, offset: -1 | 1) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  const next = date.toISOString().slice(0, 7);
  return validMonth(next) ? next : null;
}

export function calendarMonthLabel(month: string) {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
}

export function calendarMonthDays(month: string) {
  const first = new Date(`${month}-01T00:00:00Z`);
  const start = new Date(first);
  start.setUTCDate(1 - (first.getUTCDay() + 6) % 7);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return {
      date: `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`,
      day: date.getUTCDate(),
      inMonth: date.getUTCFullYear() === first.getUTCFullYear() && date.getUTCMonth() === first.getUTCMonth()
    };
  });
}
