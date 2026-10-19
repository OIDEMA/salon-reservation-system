import { ReservationStatus, type Prisma } from "@prisma/client";

export type ReservationCapacityInput = {
  tenantId: string;
  salonId: string;
  startsAt: Date;
  endsAt: Date;
  staffId?: string | null;
  excludeReservationId?: string;
};

export const capacityReservationStatuses: ReservationStatus[] = ["PENDING", "CONFIRMED", "ARRIVED", "COMPLETED"];
export type ReservationCapacityProblem = { statusCode: number; code: string; message: string };
type CapacityDatabase = Pick<Prisma.TransactionClient, "salonSettings" | "reservation" | "shift" | "staff">;

export class ReservationCapacityError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(problem: ReservationCapacityProblem) {
    super(problem.message);
    this.name = "ReservationCapacityError";
    this.statusCode = problem.statusCode;
    this.code = problem.code;
  }
}

/** Maximum simultaneous occupancy inside a half-open requested interval. */
export function peakConcurrentReservations(
  reservations: ReadonlyArray<{ startsAt: Date; endsAt: Date }>, startsAt: Date, endsAt: Date
): number {
  const start = startsAt.getTime();
  const end = endsAt.getTime();
  const events: Array<{ time: number; change: number }> = [];
  for (const reservation of reservations) {
    const occupiedStart = Math.max(start, reservation.startsAt.getTime());
    const occupiedEnd = Math.min(end, reservation.endsAt.getTime());
    if (occupiedStart < occupiedEnd) {
      events.push({ time: occupiedStart, change: 1 }, { time: occupiedEnd, change: -1 });
    }
  }
  // End events precede starts, so adjacent reservations never overlap.
  events.sort((left, right) => left.time - right.time || left.change - right.change);
  let occupied = 0;
  let maximum = 0;
  for (const event of events) {
    occupied += event.change;
    maximum = Math.max(maximum, occupied);
  }
  return maximum;
}

/** Read-only check; callers performing writes must use assertReservationCapacity in their transaction. */
export async function reservationCapacityProblem(db: CapacityDatabase, input: ReservationCapacityInput): Promise<ReservationCapacityProblem | null> {
  const { tenantId, salonId, startsAt, endsAt, staffId, excludeReservationId } = input;
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || startsAt >= endsAt) {
    return { statusCode: 400, code: "INVALID_RESERVATION_TIME", message: "予約日時を確認してください。" };
  }
  const [settings, overlaps, unavailableShifts, staff] = await Promise.all([
    db.salonSettings.findUnique({ where: { tenantId_salonId: { tenantId, salonId } } }),
    db.reservation.findMany({
      where: {
        tenantId, salonId, status: { in: capacityReservationStatuses },
        startsAt: { lt: endsAt }, endsAt: { gt: startsAt },
        ...(excludeReservationId ? { id: { not: excludeReservationId } } : {})
      },
      select: { startsAt: true, endsAt: true, staffId: true }
    }),
    db.shift.findMany({
      where: {
        tenantId, salonId, type: { in: ["OFF", "BREAK", "SALES_STOP"] },
        startsAt: { lt: endsAt }, endsAt: { gt: startsAt },
        ...(staffId ? { OR: [{ staffId: null }, { staffId }] } : { staffId: null })
      },
      select: { staffId: true }
    }),
    staffId ? db.staff.findFirst({ where: { id: staffId, tenantId, salonId, active: true }, select: { parallelCapacity: true } }) : null
  ]);
  if (settings && !settings.acceptingReservations) {
    return { statusCode: 409, code: "RESERVATIONS_SUSPENDED", message: "現在、予約受付を停止しています。" };
  }
  if (unavailableShifts.some((shift) => shift.staffId === null)) {
    return { statusCode: 409, code: "SALON_UNAVAILABLE", message: "店舗は指定時間に予約を受け付けていません。" };
  }
  if (settings && peakConcurrentReservations(overlaps, startsAt, endsAt) >= settings.maxConcurrentReservations) {
    return { statusCode: 409, code: "SALON_CAPACITY_EXCEEDED", message: "店舗の同時受付上限に達しています。" };
  }
  if (!staffId) return null;
  if (!staff) {
    return { statusCode: 400, code: "INVALID_STAFF", message: "担当スタッフが見つかりません。" };
  }
  if (peakConcurrentReservations(overlaps.filter((reservation) => reservation.staffId === staffId), startsAt, endsAt) >= staff.parallelCapacity) {
    return { statusCode: 409, code: "STAFF_CONFLICT", message: "担当スタッフの同時間帯の受付上限に達しています。" };
  }
  if (unavailableShifts.some((shift) => shift.staffId === staffId)) {
    return { statusCode: 409, code: "STAFF_UNAVAILABLE", message: "担当スタッフは指定時間に受付できません。" };
  }
  return null;
}

/** Call after locking Tenant. Every member/admin placement change locks the same scoped salon row. */
export async function assertReservationCapacity(tx: Prisma.TransactionClient, input: ReservationCapacityInput): Promise<void> {
  const salons = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Salon" WHERE "tenantId"=${input.tenantId} AND id=${input.salonId} FOR UPDATE`;
  if (!salons.length) {
    throw new ReservationCapacityError({ statusCode: 404, code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  }
  const problem = await reservationCapacityProblem(tx, input);
  if (problem) throw new ReservationCapacityError(problem);
}
