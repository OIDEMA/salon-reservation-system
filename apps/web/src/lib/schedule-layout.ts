import type { HistoricalScheduleReservation, ScheduleReservation, ScheduleRow } from "./types";

export const SCHEDULE_HOUR_WIDTH = 132;
export const SCHEDULE_LANE_HEIGHT = 76;

export function scheduleMinutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function scheduleCardKey(kind: "reservation" | "history", id: string) {
  return `${kind}:${id}`;
}

export function scheduleRowAcceptsNewReservation(row: ScheduleRow | undefined) {
  return Boolean(row && row.active !== false);
}

export type ScheduleCardLayout = {
  left: number;
  width: number;
  lane: number;
};

export function buildScheduleLayout(rows: ScheduleRow[], reservations: ScheduleReservation[], history: HistoricalScheduleReservation[], start: number, end: number) {
  const cards = new Map<string, ScheduleCardLayout>();
  const rowLayouts: Array<{ row: ScheduleRow; top: number; height: number }> = [];
  let height = 0;
  for (const row of rows) {
    const intervals = [
      ...reservations.filter((item) => item.rowId === row.id).map((item) => ({
        key: scheduleCardKey("reservation", item.id), start: scheduleMinutes(item.startTime), end: scheduleMinutes(item.endTime)
      })),
      ...history.filter((item) => item.rowId === row.id).map((item) => ({
        key: scheduleCardKey("history", item.id), start: scheduleMinutes(item.startTime),
        // A marker width makes a missing end time selectable; it does not change
        // the source value or claim a duration in the card's label.
        end: item.endTime ? scheduleMinutes(item.endTime) : scheduleMinutes(item.startTime) + 30
      }))
    ].map((item) => {
      const visibleStart = Math.min(end - 1, Math.max(start, item.start));
      const left = (visibleStart - start) / 60 * SCHEDULE_HOUR_WIDTH;
      const width = Math.min((end - visibleStart) / 60 * SCHEDULE_HOUR_WIDTH,
        Math.max(72, (Math.min(end, Math.max(item.end, item.start + 1)) - visibleStart) / 60 * SCHEDULE_HOUR_WIDTH - 8));
      return { ...item, left, width, visibleStart, visibleEnd: visibleStart + width / SCHEDULE_HOUR_WIDTH * 60 };
    }).sort((a, b) => a.visibleStart - b.visibleStart || a.visibleEnd - b.visibleEnd || a.key.localeCompare(b.key));
    const laneEnds: number[] = [];
    for (const item of intervals) {
      let lane = laneEnds.findIndex((laneEnd) => laneEnd <= item.visibleStart);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = item.visibleEnd;
      cards.set(item.key, { left: item.left, width: item.width, lane });
    }
    const rowHeight = Math.max(1, laneEnds.length) * SCHEDULE_LANE_HEIGHT;
    rowLayouts.push({ row, top: height, height: rowHeight });
    height += rowHeight;
  }
  return { rows: rowLayouts, cards, height };
}
