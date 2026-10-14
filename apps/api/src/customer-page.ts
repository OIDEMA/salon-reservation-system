import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { customerAccountingTotals } from "./accounting-stats.js";

export const customerPageQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(30).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
});

export type CustomerPageQuery = z.infer<typeof customerPageQuerySchema>;
type CustomerPageScope = { tenantId: string; salonId: string; readMemo: boolean; readCheckout: boolean };

/** Query every registered customer while only returning one light summary page. */
export async function customerPage(database: PrismaClient, scope: CustomerPageScope, query: CustomerPageQuery) {
  const where: Prisma.CustomerWhereInput = {
    tenantId: scope.tenantId, salonId: scope.salonId,
    ...(query.tag ? { tags: { has: query.tag } } : {}),
    ...(query.q ? { OR: [
      { name: { contains: query.q, mode: "insensitive" } },
      { kana: { contains: query.q, mode: "insensitive" } },
      { phone: { contains: query.q, mode: "insensitive" } },
      { lineDisplayName: { contains: query.q, mode: "insensitive" } },
      ...(scope.readMemo ? [{ memo: { contains: query.q, mode: "insensitive" as const } }] : []),
      { tags: { has: query.q } }
    ] } : {})
  };
  // A shared snapshot keeps the count, clamped page and rows consistent when a
  // customer is added/deleted while this request is running.
  return database.$transaction(async (tx) => {
    const total = await tx.customer.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const rows = await tx.customer.findMany({
      where, orderBy: [{ lastVisitAt: "desc" }, { kana: "asc" }, { id: "asc" }],
      skip: (page - 1) * query.pageSize, take: query.pageSize,
      select: { id: true, name: true, kana: true, phone: true, lineDisplayName: true,
        tags: true, visitCount: true, lastVisitAt: true }
    });
    const totals = scope.readCheckout
      ? await customerAccountingTotals(tx, scope.tenantId, scope.salonId, rows.map(({ id }) => id))
      : null;
    return { customers: rows.map((row) => ({ ...row, totalSpent: totals ? totals.get(row.id) ?? 0 : null })),
      total, page, pageSize: query.pageSize, totalPages };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
