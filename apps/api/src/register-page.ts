import { CashRegisterStatus, Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { CASH_MAX_YEN, cashAssert } from "./cash-domain.js";
import { listPageQuerySchema } from "./reservation-page.js";

export const registerPageQuerySchema = listPageQuerySchema.extend({ status: z.nativeEnum(CashRegisterStatus).optional() });
const summarySelect = { id: true, businessDate: true, status: true, openingCashYen: true,
  expectedCashYen: true, differenceYen: true } satisfies Prisma.CashRegisterSessionSelect;
type Summary = Prisma.CashRegisterSessionGetPayload<{ select: typeof summarySelect }>;
type Scope = { tenantId: string; salonId: string };

/** Aggregate only the selected open registers; never load their movement details. */
async function summaries(tx: Prisma.TransactionClient, scope: Scope, rows: Summary[]) {
  const openIds = rows.filter((row) => row.status === "OPEN").map(({ id }) => id);
  const totals = openIds.length ? await tx.$queryRaw<Array<{ sessionId: string; net: bigint }>>(Prisma.sql`
    SELECT "sessionId", SUM(CASE WHEN kind IN ('IN', 'SALE') THEN "amountYen" ELSE -"amountYen" END)::bigint AS net
    FROM "CashRegisterMovement"
    WHERE "tenantId"=${scope.tenantId} AND "salonId"=${scope.salonId} AND "sessionId" IN (${Prisma.join(openIds)})
    GROUP BY "sessionId"
  `) : [];
  const byId = new Map(totals.map((row) => [row.sessionId, Number(row.net)]));
  return rows.map((row) => {
    const expectedCashYen = row.status === "CLOSED" ? row.expectedCashYen : row.openingCashYen + (byId.get(row.id) ?? 0);
    cashAssert(expectedCashYen !== null && Number.isSafeInteger(expectedCashYen) && Math.abs(expectedCashYen) <= CASH_MAX_YEN,
      "REGISTER_AMOUNT_LIMIT", "レジの金額を確認してください。");
    return { ...row, expectedCashYen };
  });
}

export async function registerPage(database: PrismaClient, scope: Scope, query: z.infer<typeof registerPageQuerySchema>) {
  const where: Prisma.CashRegisterSessionWhereInput = { ...scope, ...(query.status ? { status: query.status } : {}),
    ...(query.q ? { OR: [{ businessDate: { contains: query.q } }, { note: { contains: query.q, mode: "insensitive" } }] } : {}) };
  return database.$transaction(async (tx) => {
    const total = await tx.cashRegisterSession.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const rows = await tx.cashRegisterSession.findMany({ where, select: summarySelect,
      orderBy: [{ businessDate: "desc" }, { id: "desc" }], skip: (page - 1) * query.pageSize, take: query.pageSize });
    return { registers: await summaries(tx, scope, rows), total, page, pageSize: query.pageSize, totalPages };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** The settlement screen needs only today's open register choices. */
export async function openRegisterOptions(database: PrismaClient, scope: Scope, businessDate: string) {
  return database.$transaction(async (tx) => {
    const rows = await tx.cashRegisterSession.findMany({ where: { ...scope, status: "OPEN", businessDate }, select: summarySelect,
      orderBy: [{ businessDate: "desc" }, { id: "desc" }], take: 20 });
    return summaries(tx, scope, rows);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
