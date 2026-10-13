import { Prisma } from "@prisma/client";

export async function customerAccountingTotals(tx: Prisma.TransactionClient, tenantId: string, salonId: string, customerIds: string[]) {
  if (!customerIds.length) return new Map<string, number>();
  const rows = await tx.$queryRaw<{ customerId: string; total: bigint }[]>`
    SELECT r."customerId", SUM(c."totalYen")::bigint AS total
    FROM "CashCheckout" c
    JOIN "Reservation" r ON r.id=c."reservationId" AND r."tenantId"=c."tenantId" AND r."salonId"=c."salonId"
    WHERE c."tenantId"=${tenantId} AND c."salonId"=${salonId} AND c.status='FINALIZED'
      AND r."customerId" IN (${Prisma.join(customerIds)})
    GROUP BY r."customerId"`;
  return new Map(rows.map((row) => [row.customerId, Number(row.total)]));
}

export async function refreshCustomerAccounting(tx: Prisma.TransactionClient, tenantId: string, salonId: string, customerId: string) {
  const totals = await customerAccountingTotals(tx, tenantId, salonId, [customerId]);
  await tx.customer.updateMany({ where: { tenantId, salonId, id: customerId }, data: { totalSpent: totals.get(customerId) ?? 0 } });
}
