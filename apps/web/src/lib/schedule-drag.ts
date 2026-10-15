import type { HistoricalScheduleReservation, ScheduleRow } from "./types";
import { tenantApiPath } from "./tenant-routing";

export const SCHEDULE_DRAG_THRESHOLD = 5;

export function scheduleDragStarted(originX: number, originY: number, x: number, y: number) {
  return Math.hypot(x - originX, y - originY) >= SCHEDULE_DRAG_THRESHOLD;
}

// Snap the movement, rather than the absolute pointer time. A 10:15 booking
// therefore stays at :15 until a whole step has actually been dragged.
export function scheduleDragDelta(originX: number, x: number, hourWidth: number, step: number) {
  return Math.round((x - originX) / hourWidth * 60 / step) * step;
}

// Keep the original minute offset even at the board edges. Clamping an
// absolute time to 23:59 would silently turn a :15 slot into a :59 slot.
export function scheduleMoveStart(originalStart: number, delta: number, minimum: number, maximum: number, step: number) {
  const minimumDelta = Math.ceil((minimum - originalStart) / step) * step;
  const maximumDelta = Math.floor((maximum - originalStart) / step) * step;
  if (minimumDelta > maximumDelta) return null;
  return originalStart + Math.min(maximumDelta, Math.max(minimumDelta, delta));
}

export function scheduleDropSlot(x: number, y: number, bounds: { left: number; top: number; width: number; height: number },
  rows: Array<{ row: ScheduleRow; top: number; height: number }>, start: number, end: number, hourWidth: number, step: number, allowInactive = false) {
  const localX = x - bounds.left;
  const localY = y - bounds.top;
  // Releasing outside the board must cancel the change, never clamp it onto
  // a different customer/staff slot at the nearest edge.
  if (localX < 0 || localX >= bounds.width || localY < 0 || localY >= bounds.height) return null;
  const rowIndex = rows.findIndex((row) => localY >= row.top && localY < row.top + row.height);
  const row = rows[rowIndex]?.row;
  if (!row || (!allowInactive && row.active === false)) return null;
  return { rowIndex, minutes: Math.min(end - step, Math.max(start, Math.floor((start + localX / hourWidth * 60) / step) * step)) };
}

export function historyScheduleDuration(reservation: HistoricalScheduleReservation) {
  if (!reservation.endsAt) return null;
  const duration = (Date.parse(reservation.endsAt) - Date.parse(reservation.startsAt)) / 60_000;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

export function historyScheduleDate(startsAt: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(startsAt));
}

export type HistoryScheduleChange = { date: string; startTime: string; staffId: string | null; expectedVersion: number };
export type HistoryScheduleResult = { id: string; startsAt: string; endsAt: string | null; rowId: string; staffName: string | null; scheduleVersion: number };
export class ScheduleUpdateError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function moveHistorySchedule(tenantSlug: string, id: string, change: HistoryScheduleChange): Promise<HistoryScheduleResult> {
  const response = await fetch(tenantApiPath(tenantSlug, `/admin/reservation-history/${encodeURIComponent(id)}/schedule`), {
    method: "PATCH", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(change)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ScheduleUpdateError(body?.message ?? `予約枠を移動できませんでした (${response.status})`, response.status);
  return body as HistoryScheduleResult;
}
