import { CashCheckoutStatus, Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { listPageQuerySchema } from "./reservation-page.js";

export const checkoutPageQuerySchema = listPageQuerySchema.extend({ status: z.nativeEnum(CashCheckoutStatus).optional() });

export async function checkoutPage(database: PrismaClient, scope: { tenantId: string; salonId: string }, query: z.infer<typeof checkoutPageQuerySchema>) {
  const where: Prisma.CashCheckoutWhereInput = { ...scope, ...(query.status ? { status: query.status } : {}),
    ...(query.q ? { OR: [
      { reservationSnapshot: { path: ["customerName"], string_contains: query.q } },
      { reservationSnapshot: { path: ["serviceName"], string_contains: query.q } },
      { reservation: { customer: { name: { contains: query.q, mode: "insensitive" } } } },
      { reservation: { customer: { kana: { contains: query.q, mode: "insensitive" } } } },
      { reservation: { customer: { phone: { contains: query.q, mode: "insensitive" } } } },
      { reservation: { service: { name: { contains: query.q, mode: "insensitive" } } } }
    ] } : {}) };
  return database.$transaction(async (tx) => {
    const total = await tx.cashCheckout.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const rows = await tx.cashCheckout.findMany({ where,
      select: { id: true, reservationId: true, status: true, totalYen: true, createdAt: true, reservationSnapshot: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * query.pageSize, take: query.pageSize });
    // Never return mutable line items, payment references or free-form notes in a list.
    return { checkouts: rows.map(({ reservationSnapshot, ...row }) => {
      const snapshot = reservationSnapshot && typeof reservationSnapshot === "object" && !Array.isArray(reservationSnapshot) ? reservationSnapshot : {};
      return { ...row, customerName: typeof snapshot.customerName === "string" ? snapshot.customerName : "",
        serviceName: typeof snapshot.serviceName === "string" ? snapshot.serviceName : "" };
    }), total, page, pageSize: query.pageSize, totalPages };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
