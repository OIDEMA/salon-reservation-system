import type { FastifyInstance } from "fastify";
import type { Prisma, EmailOutbox } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./database.js";
import { cashAssert, cashRequestHash } from "./cash-domain.js";
import { requireOperationContext, lockOperation, operationAudit, runSerializable, type OperationContext } from "./operations-support.js";
import { RECEIPT_EVENT, receiptInputSchema, receiptPayloadSchema, createReceiptSnapshot, buildReceiptEmail } from "./receipt-email.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const checkoutInclude = { items: { orderBy: { lineNumber: "asc" as const } }, payments: true };
const previewInputSchema = receiptInputSchema.omit({ requestId: true });
const scope = (context: OperationContext) => ({ tenantId: context.tenant.id, salonId: context.salon.id });
const eventPrefix = (checkoutId: string) => `${RECEIPT_EVENT}:${checkoutId}:`;

async function checkoutFor(database: Prisma.TransactionClient, context: OperationContext, id: string) {
  const checkout = await database.cashCheckout.findFirst({ where: { ...scope(context), id }, include: checkoutInclude });
  cashAssert(checkout, "CHECKOUT_NOT_FOUND", "会計が見つかりません。", 404);
  return checkout;
}

function historyEntry(item: EmailOutbox) {
  const payload = receiptPayloadSchema.parse(item.payload);
  return { id: item.id, recipientEmail: item.recipientEmail, recipientName: payload.receipt.recipientName,
    description: payload.receipt.description, status: item.status, createdAt: item.createdAt,
    sentAt: item.sentAt, lastErrorCode: item.lastErrorCode };
}

export function registerReceiptEmailRoutes(server: FastifyInstance) {
  server.get("/api/cash/checkouts/:id/receipt-emails", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.read");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const checkout = await checkoutFor(prisma, context, id);
    const items = await prisma.emailOutbox.findMany({ where: { ...scope(context), eventType: RECEIPT_EVENT,
      eventKey: { startsWith: eventPrefix(id) } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
    const snapshot = checkout.reservationSnapshot as Record<string, unknown>;
    return reply.header("Cache-Control", "private, no-store").send({
      defaultRecipientEmail: items[0]?.recipientEmail ?? "",
      defaultRecipientName: typeof snapshot.customerName === "string" ? snapshot.customerName : "",
      defaultDescription: "施術代として", history: items.map(historyEntry)
    });
  });

  server.post("/api/cash/checkouts/:id/receipt-emails/preview", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.write");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const input = previewInputSchema.parse(request.body);
    const checkout = await checkoutFor(prisma, context, id);
    cashAssert(checkout.version === input.version, "CASH_VERSION_CONFLICT", "会計が更新されました。最新の状態を取得してください。", 409);
    return reply.header("Cache-Control", "private, no-store").send(buildReceiptEmail(createReceiptSnapshot(checkout, input)));
  });

  server.post("/api/cash/checkouts/:id/receipt-emails", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.write");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const input = receiptInputSchema.parse(request.body);
    const { requestId, ...content } = input;
    const requestHash = cashRequestHash(content);
    const eventKey = `${eventPrefix(id)}${requestId}`;
    const result = await runSerializable(async (tx) => {
      await lockOperation(tx, context, "checkout.write");
      const checkout = await checkoutFor(tx, context, id);
      const previous = await tx.emailOutbox.findFirst({ where: { ...scope(context), eventType: RECEIPT_EVENT, eventKey } });
      if (previous) {
        const payload = receiptPayloadSchema.parse(previous.payload);
        cashAssert(payload.requestHash === requestHash, "RECEIPT_REQUEST_CONFLICT", "同じ送付番号に異なる内容が指定されています。", 409);
        return historyEntry(previous);
      }
      cashAssert(checkout.version === input.version, "CASH_VERSION_CONFLICT", "会計が更新されました。最新の状態を取得してください。", 409);
      const receipt = createReceiptSnapshot(checkout, input);
      // Validate the complete customer-facing message before committing the queue.
      buildReceiptEmail(receipt);
      const payload = receiptPayloadSchema.parse({ checkoutId: id, requestId, requestHash, receipt });
      const item = await tx.emailOutbox.create({ data: { ...scope(context), eventType: RECEIPT_EVENT,
        eventKey, recipientEmail: input.recipientEmail, payload } });
      await operationAudit(tx, context, request, { action: "checkout.receipt.queue", resource: "cashCheckout", resourceId: id,
        metadata: { outboxId: item.id, receiptNumber: receipt.receiptNumber } });
      return historyEntry(item);
    });
    return reply.header("Cache-Control", "private, no-store").code(202).send(result);
  });
}
