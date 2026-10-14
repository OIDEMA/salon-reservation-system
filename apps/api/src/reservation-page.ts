import { Prisma, ReservationStatus, type PrismaClient } from "@prisma/client";
import { z } from "zod";

export const listPageQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "日付を確認してください。");
export const reservationPageQuerySchema = listPageQuerySchema.extend({
  status: z.nativeEnum(ReservationStatus).optional(), dateFrom: date.optional(), dateTo: date.optional()
}).refine((value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo, "終了日は開始日以降を指定してください。");
export const reservationOptionsQuerySchema = z.object({ q: z.string().trim().max(100).optional() });
type Scope = { tenantId: string; salonId: string };
type Query = z.infer<typeof reservationPageQuerySchema>;

const summarySelect = {
  id: true, startsAt: true, endsAt: true, status: true, source: true,
  customer: { select: { id: true, name: true, kana: true, phone: true } },
  service: { select: { id: true, name: true, price: true } },
  staff: { select: { id: true, name: true } }
} satisfies Prisma.ReservationSelect;
type Summary = Prisma.ReservationGetPayload<{ select: typeof summarySelect }>;
const japanDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
const japanTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function reservationListSummary(row: Summary) {
  return { id: row.id, date: japanDate.format(row.startsAt), startTime: japanTime.format(row.startsAt),
    endTime: japanTime.format(row.endsAt), status: row.status, source: row.source,
    customer: row.customer, service: row.service, staff: row.staff };
}

function whereFor(scope: Scope, query: Query | z.infer<typeof reservationOptionsQuerySchema>, options = false): Prisma.ReservationWhereInput {
  const dateFrom = "dateFrom" in query && query.dateFrom ? new Date(`${query.dateFrom}T00:00:00+09:00`) : undefined;
  const dateTo = "dateTo" in query && query.dateTo ? new Date(new Date(`${query.dateTo}T00:00:00+09:00`).getTime() + 86_400_000) : undefined;
  return { ...scope,
    ...(options ? { status: { notIn: [ReservationStatus.CANCELLED, ReservationStatus.NO_SHOW] } }
      : "status" in query && query.status ? { status: query.status } : {}),
    ...(dateFrom || dateTo ? { startsAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lt: dateTo } : {}) } } : {}),
    ...(query.q ? { OR: [
      { customer: { name: { contains: query.q, mode: "insensitive" } } },
      { customer: { kana: { contains: query.q, mode: "insensitive" } } },
      { customer: { phone: { contains: query.q, mode: "insensitive" } } },
      { service: { name: { contains: query.q, mode: "insensitive" } } },
      ...(!options ? [{ memo: { contains: query.q, mode: "insensitive" as const } }] : [])
    ] } : {})
  };
}

export async function reservationPage(database: PrismaClient, scope: Scope, query: Query) {
  const where = whereFor(scope, query);
  return database.$transaction(async (tx) => {
    const total = await tx.reservation.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const rows = await tx.reservation.findMany({ where, select: summarySelect,
      orderBy: [{ startsAt: "desc" }, { id: "desc" }], skip: (page - 1) * query.pageSize, take: query.pageSize });
    return { reservations: rows.map(reservationListSummary), total, page, pageSize: query.pageSize, totalPages };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** The checkout selector searches on demand instead of loading all reservations. */
export async function reservationOptions(database: PrismaClient, scope: Scope, query: z.infer<typeof reservationOptionsQuerySchema>) {
  const rows = await database.reservation.findMany({ where: whereFor(scope, query, true),
    select: { id: true, startsAt: true, customer: { select: { name: true } }, service: { select: { name: true } } },
    orderBy: [{ startsAt: "desc" }, { id: "desc" }], take: 21 });
  return { reservations: rows.slice(0, 20).map((row) => ({ id: row.id, date: japanDate.format(row.startsAt),
    startTime: japanTime.format(row.startsAt), customerName: row.customer.name, serviceName: row.service.name })), hasMore: rows.length > 20 };
}
