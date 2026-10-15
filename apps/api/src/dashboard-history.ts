import { Prisma, ReservationStatus, type PrismaClient } from "@prisma/client";
import { z } from "zod";

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "日付を確認してください。");

export const dashboardQuerySchema = z.object({
  date: calendarDate.optional(),
  q: z.string().trim().max(100).refine((value) => !value.includes("\0")).optional(),
  status: z.union([z.literal("ALL"), z.nativeEnum(ReservationStatus)]).default("ALL"),
  sourceStatus: z.string().trim().min(1).max(100).optional()
});
export type DashboardFilters = Pick<z.infer<typeof dashboardQuerySchema>, "q" | "status" | "sourceStatus">;
type Scope = { tenantId: string; salonId: string };
export const HISTORICAL_DASHBOARD_LIMIT = 1000;

export function japanDayBounds(date: string) {
  calendarDate.parse(date);
  const start = new Date(`${date}T00:00:00.000+09:00`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** Elapsed hours retain next-day end times instead of wrapping 24:30 to 00:30. */
export function scheduleTime(date: Date, dayStart: Date) {
  const minutes = Math.max(0, Math.floor((date.getTime() - dayStart.getTime()) / 60_000));
  return `${Math.floor(minutes / 60).toString().padStart(2, "0")}:${(minutes % 60).toString().padStart(2, "0")}`;
}

export function dashboardReservationWhere(scope: Scope, day: { start: Date; end: Date }, filters: DashboardFilters): Prisma.ReservationWhereInput {
  return {
    ...scope,
    startsAt: { gte: day.start, lt: day.end },
    ...(filters.status !== "ALL" ? { status: filters.status } : {}),
    ...(filters.q ? { OR: [
      { customer: { name: { contains: filters.q, mode: "insensitive" } } },
      { customer: { kana: { contains: filters.q, mode: "insensitive" } } },
      { customer: { phone: { contains: filters.q, mode: "insensitive" } } },
      { service: { name: { contains: filters.q, mode: "insensitive" } } },
      { staff: { name: { contains: filters.q, mode: "insensitive" } } },
      { id: { contains: filters.q, mode: "insensitive" } },
      { memo: { contains: filters.q, mode: "insensitive" } },
      { customer: { tags: { has: filters.q } } }
    ] } : {})
  };
}

const historySelect = {
  id: true, externalReservationId: true, staffId: true, source: true,
  customerName: true, customerKana: true, staffName: true, sourceStatus: true,
  startsAt: true, endsAt: true, menuText: true, reservationAmount: true, nominated: true
} satisfies Prisma.HistoricalReservationSelect;
type HistoricalScheduleRecord = Prisma.HistoricalReservationGetPayload<{ select: typeof historySelect }> & { scheduleVersion?: number };

export function historicalScheduleCard(record: HistoricalScheduleRecord, dayStart: Date) {
  return {
    id: record.id,
    externalReservationId: record.externalReservationId,
    rowId: record.staffId ?? "unassigned",
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt?.toISOString() ?? null,
    startTime: scheduleTime(record.startsAt, dayStart),
    endTime: record.endsAt ? scheduleTime(record.endsAt, dayStart) : null,
    customerName: record.customerName,
    customerKana: record.customerKana,
    staffName: record.staffName,
    serviceName: record.menuText ?? "メニュー未記録",
    reservationAmount: record.reservationAmount,
    sourceStatus: record.sourceStatus,
    source: record.source,
    isRequest: record.nominated ?? false,
    readOnly: true as const,
    scheduleVersion: record.scheduleVersion ?? 0
  };
}
export type HistoricalScheduleCard = ReturnType<typeof historicalScheduleCard>;

/** Only selected-day summaries are read. Original charts/notes/financial rows stay in the permission-gated detail route. */
export async function dashboardHistory(database: Pick<PrismaClient, "$queryRaw">, scope: Scope,
  day: { start: Date; end: Date }, filters: DashboardFilters) {
  // Original SalonBoard states cannot safely be treated as operational reservation states.
  if (filters.status !== "ALL") return { historicalReservations: [], historicalHasMore: false };
  const pattern = filters.q ? `%${filters.q.replace(/[!%_]/g, (character) => `!${character}`)}%` : null;
  const records = await database.$queryRaw<HistoricalScheduleRecord[]>(Prisma.sql`
    WITH candidates AS (
      SELECT h.id, h."startsAt" FROM "HistoricalReservation" h
      WHERE h."tenantId" = ${scope.tenantId} AND h."salonId" = ${scope.salonId}
        AND h."startsAt" >= ${day.start.toISOString()}::timestamp AND h."startsAt" < ${day.end.toISOString()}::timestamp
        AND NOT EXISTS (SELECT 1 FROM "HistoricalReservationScheduleOverride" s WHERE s."historicalReservationId" = h.id)
      UNION ALL
      SELECT s."historicalReservationId" AS id, s."startsAt" FROM "HistoricalReservationScheduleOverride" s
      WHERE s."tenantId" = ${scope.tenantId} AND s."salonId" = ${scope.salonId}
        AND s."startsAt" >= ${day.start.toISOString()}::timestamp AND s."startsAt" < ${day.end.toISOString()}::timestamp
    )
    SELECT h.id, h."externalReservationId", h.source, h."customerName", h."customerKana", h."sourceStatus",
      h."menuText", h."reservationAmount", h.nominated,
      CASE WHEN s.id IS NULL THEN h."staffId" ELSE s."staffId" END AS "staffId",
      CASE WHEN s.id IS NULL THEN h."staffName" ELSE assigned.name END AS "staffName",
      c."startsAt", CASE WHEN s.id IS NULL THEN h."endsAt" ELSE s."endsAt" END AS "endsAt",
      COALESCE(s.version, 0) AS "scheduleVersion"
    FROM candidates c JOIN "HistoricalReservation" h ON h.id = c.id
      LEFT JOIN "HistoricalReservationScheduleOverride" s ON s."historicalReservationId" = h.id
        AND s."tenantId" = ${scope.tenantId} AND s."salonId" = ${scope.salonId}
      LEFT JOIN "Staff" assigned ON assigned.id = CASE WHEN s.id IS NULL THEN h."staffId" ELSE s."staffId" END
        AND assigned."tenantId" = ${scope.tenantId} AND assigned."salonId" = ${scope.salonId}
    WHERE h."tenantId" = ${scope.tenantId} AND h."salonId" = ${scope.salonId}
      ${filters.sourceStatus ? Prisma.sql`AND h."sourceStatus" = ${filters.sourceStatus}` : Prisma.empty}
      ${pattern ? Prisma.sql`AND (h."customerName" ILIKE ${pattern} ESCAPE '!' OR h."customerKana" ILIKE ${pattern} ESCAPE '!'
        OR (CASE WHEN s.id IS NULL THEN h."staffName" ELSE assigned.name END) ILIKE ${pattern} ESCAPE '!'
        OR assigned.name ILIKE ${pattern} ESCAPE '!' OR h."menuText" ILIKE ${pattern} ESCAPE '!'
        OR h."externalReservationId" ILIKE ${pattern} ESCAPE '!')` : Prisma.empty}
    ORDER BY c."startsAt" ASC, h.id ASC LIMIT ${HISTORICAL_DASHBOARD_LIMIT + 1}
  `);
  return {
    historicalReservations: records.slice(0, HISTORICAL_DASHBOARD_LIMIT).map((record) => historicalScheduleCard(record, day.start)),
    historicalHasMore: records.length > HISTORICAL_DASHBOARD_LIMIT
  };
}

type ScheduleStaff = { id: string; name: string; role: string; color: string; active: boolean };
type AssignedReservation = { staffId: string | null; isRequest: boolean };

export function dashboardScheduleRows(staff: ScheduleStaff[], reservations: AssignedReservation[], shifts: Array<{ staffId: string | null }>, history: HistoricalScheduleCard[]) {
  const counts = new Map<string, number>();
  const nominationCounts = new Map<string, number>();
  const historicalRows = new Set<string>();
  const increment = (rowId: string, nominated: boolean) => {
    counts.set(rowId, (counts.get(rowId) ?? 0) + 1);
    if (nominated) nominationCounts.set(rowId, (nominationCounts.get(rowId) ?? 0) + 1);
  };
  for (const reservation of reservations) increment(reservation.staffId ?? "unassigned", reservation.isRequest);
  for (const reservation of history) {
    increment(reservation.rowId, reservation.isRequest);
    historicalRows.add(reservation.rowId);
  }
  const visibleRows = new Set([...counts.keys(), ...shifts.flatMap((shift) => shift.staffId ? [shift.staffId] : [])]);
  return [
    { id: "unassigned", type: "unassigned", label: "指名なし", subtitle: "自動割当待ち", color: "#334155", active: true, count: counts.get("unassigned") ?? 0 },
    ...staff.filter((member) => member.active || visibleRows.has(member.id)).map((member) => ({
      id: member.id,
      type: member.role === "ROOM_RESOURCE" ? "resource" : "staff",
      label: member.name,
      subtitle: member.active ? `${member.role.toLowerCase()} / 指名 ${nominationCounts.get(member.id) ?? 0}`
        : historicalRows.has(member.id) ? "過去の担当 / 受付停止" : "受付停止",
      color: member.color,
      active: member.active,
      count: counts.get(member.id) ?? 0
    }))
  ];
}

/** Extending the display window never adds bookable capacity or changes salon hours. */
export function dashboardDisplayHours(start: string, end: string, cards: Array<{ startTime: string; endTime: string | null }>) {
  const toMinutes = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };
  let first = toMinutes(start);
  let last = toMinutes(end);
  for (const card of cards) {
    first = Math.min(first, toMinutes(card.startTime));
    // A missing end stays unknown; only enough space for its labelled marker is shown.
    last = Math.max(last, card.endTime ? toMinutes(card.endTime) : toMinutes(card.startTime) + 30);
  }
  const format = (minutes: number) => `${Math.floor(minutes / 60).toString().padStart(2, "0")}:${(minutes % 60).toString().padStart(2, "0")}`;
  return { start: format(Math.floor(first / 60) * 60), end: format(Math.ceil(last / 60) * 60), stepMinutes: 30 };
}

/** A history-linked staff row must be retained even when it has no live reservations or shifts. */
export async function staffScheduleDependencyCount(database: Pick<PrismaClient, "reservation" | "shift" | "historicalReservation" | "historicalReservationScheduleOverride">,
  scope: Scope, staffId: string) {
  const where = { ...scope, staffId };
  const counts = await Promise.all([
    database.reservation.count({ where }),
    database.shift.count({ where }),
    database.historicalReservation.count({ where }),
    database.historicalReservationScheduleOverride.count({ where })
  ]);
  return counts.reduce((total, count) => total + count, 0);
}
