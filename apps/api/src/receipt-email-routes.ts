import type { FastifyInstance } from "fastify";
import { Prisma, type EmailOutbox } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "./database.js";
import { cashAssert, cashRequestHash } from "./cash-domain.js";
import { requireOperationContext, lockOperation, operationAudit, runSerializable, type OperationContext } from "./operations-support.js";
import { RECEIPT_EVENT, receiptInputSchema, receiptPayloadSchema, createReceiptSnapshot, buildReceiptEmail } from "./receipt-email.js";
import { buildReceiptPdf, receiptPdfFileName } from "./receipt-pdf.js";
import { receiptIssuerNameSchema, invoiceRegistrationNumberSchema } from "./receipt-settings.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const checkoutInclude = { items: { orderBy: { lineNumber: "asc" as const } }, payments: true };
const previewInputSchema = receiptInputSchema.omit({ requestId: true, previewHash: true });
const scope = (context: OperationContext) => ({ tenantId: context.tenant.id, salonId: context.salon.id });
const eventPrefix = (checkoutId: string) => `${RECEIPT_EVENT}:${checkoutId}:`;

async function receiptTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try { return await runSerializable(operation); }
  catch (error) {
    // A waiter can retain a snapshot from before the first enqueue committed:
    // locking an unchanged tenant row does not invalidate that snapshot. The
    // unique event key still prevents duplication. Retry in a fresh transaction
    // so permissions and the stored request hash are checked before replaying it.
    const target = error instanceof Prisma.PrismaClientKnownRequestError ? error.meta?.target : undefined;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" &&
      (Array.isArray(target) && target.includes("eventKey") || target === "EmailOutbox_eventKey_key")) {
      return runSerializable(operation);
    }
    throw error;
  }
}

async function checkoutFor(database: Prisma.TransactionClient, context: OperationContext, id: string) {
  const checkout = await database.cashCheckout.findFirst({ where: { ...scope(context), id }, include: checkoutInclude });
  cashAssert(checkout, "CHECKOUT_NOT_FOUND", "会計が見つかりません。", 404);
  return checkout;
}

function historyEntry(item: EmailOutbox) {
  const payload = receiptPayloadSchema.parse(item.payload);
  return { id: item.id, recipientEmail: item.recipientEmail, recipientName: payload.receipt.recipientName,
    description: payload.receipt.description, status: item.status, createdAt: item.createdAt,
    sentAt: item.sentAt, lastErrorCode: item.lastErrorCode, format: payload.attachment ? "PDF" : "TEXT" };
}

const historyMetadataSchema = z.object({
  id: z.string().min(1), recipientEmail: z.string().email().max(254),
  recipientName: receiptInputSchema.shape.recipientName, description: receiptInputSchema.shape.description,
  status: z.enum(["PENDING", "PROCESSING", "SENT", "FAILED", "SKIPPED"]),
  createdAt: z.date(), sentAt: z.date().nullable(), lastErrorCode: z.string().nullable(),
  format: z.enum(["PDF", "TEXT"])
}).strict();

async function receiptHistory(context: OperationContext, checkoutId: string) {
  // Project only display metadata inside PostgreSQL. Loading full payloads would
  // transfer and decode up to 50 PDF attachments just to display their history.
  const items = await prisma.$queryRaw<unknown[]>(Prisma.sql`
    SELECT "id", "recipientEmail", "status", "createdAt", "sentAt", "lastErrorCode",
      "payload" #>> '{receipt,recipientName}' AS "recipientName",
      "payload" #>> '{receipt,description}' AS "description",
      CASE WHEN jsonb_typeof("payload" -> 'attachment') = 'object' THEN 'PDF' ELSE 'TEXT' END AS "format"
    FROM "EmailOutbox"
    WHERE "tenantId" = ${context.tenant.id} AND "salonId" = ${context.salon.id}
      AND "eventType" = ${RECEIPT_EVENT} AND "eventKey" LIKE ${eventPrefix(checkoutId) + "%"}
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT 50
  `);
  return items.map((item) => historyMetadataSchema.parse(item));
}

async function issuerFor(database: Prisma.TransactionClient, context: OperationContext) {
  const settings = await database.salonSettings.findUnique({ where: { tenantId_salonId: scope(context) },
    select: { receiptIssuerName: true, invoiceRegistrationNumber: true } });
  return { name: settings?.receiptIssuerName ?? null, registrationNumber: settings?.invoiceRegistrationNumber ?? null,
    configured: receiptIssuerNameSchema.safeParse(settings?.receiptIssuerName).success &&
      invoiceRegistrationNumberSchema.safeParse(settings?.invoiceRegistrationNumber).success };
}

async function prepareReceipt(database: Prisma.TransactionClient, context: OperationContext,
  checkout: Awaited<ReturnType<typeof checkoutFor>>, input: z.infer<typeof previewInputSchema>) {
  const issuer = await issuerFor(database, context);
  cashAssert(issuer.configured, "RECEIPT_ISSUER_NOT_CONFIGURED", "基本設定で領収書の正式事業者名と登録番号を設定してください。", 409);
  const receipt = createReceiptSnapshot(checkout, input, { receiptIssuerName: issuer.name!, invoiceRegistrationNumber: issuer.registrationNumber! });
  const message = buildReceiptEmail(receipt);
  const bytes = await buildReceiptPdf(receipt);
  const attachment = { fileName: receiptPdfFileName(receipt), contentBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const previewHash = cashRequestHash({ receipt, message, recipientEmail: input.recipientEmail, pdfSha256: attachment.sha256 });
  return { receipt, message, attachment, previewHash };
}

export function registerReceiptEmailRoutes(server: FastifyInstance) {
  server.get("/api/cash/checkouts/:id/receipt-emails", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.read");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const checkout = await checkoutFor(prisma, context, id);
    const items = await receiptHistory(context, id);
    const snapshot = checkout.reservationSnapshot as Record<string, unknown>;
    return reply.header("Cache-Control", "private, no-store").send({
      defaultRecipientEmail: items[0]?.recipientEmail ?? "",
      defaultRecipientName: typeof snapshot.customerName === "string" ? snapshot.customerName : "",
      defaultDescription: "施術代として", history: items, issuer: await issuerFor(prisma, context)
    });
  });

  server.post("/api/cash/checkouts/:id/receipt-emails/preview", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.write");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const input = previewInputSchema.parse(request.body);
    const checkout = await checkoutFor(prisma, context, id);
    cashAssert(checkout.version === input.version, "CASH_VERSION_CONFLICT", "会計が更新されました。最新の状態を取得してください。", 409);
    const prepared = await prepareReceipt(prisma, context, checkout, input);
    return reply.header("Cache-Control", "private, no-store").send({ ...prepared.message,
      pdf: { fileName: prepared.attachment.fileName, contentBase64: prepared.attachment.contentBase64 }, previewHash: prepared.previewHash });
  });

  server.post("/api/cash/checkouts/:id/receipt-emails", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.write");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const input = receiptInputSchema.parse(request.body);
    const { requestId, ...content } = input;
    const requestHash = cashRequestHash(content);
    const eventKey = `${eventPrefix(id)}${requestId}`;
    const result = await receiptTransaction(async (tx) => {
      await lockOperation(tx, context, "checkout.write");
      const checkout = await checkoutFor(tx, context, id);
      const previous = await tx.emailOutbox.findFirst({ where: { ...scope(context), eventType: RECEIPT_EVENT, eventKey } });
      if (previous) {
        const payload = receiptPayloadSchema.parse(previous.payload);
        cashAssert(payload.requestHash === requestHash, "RECEIPT_REQUEST_CONFLICT", "同じ送付番号に異なる内容が指定されています。", 409);
        return historyEntry(previous);
      }
      cashAssert(checkout.version === input.version, "CASH_VERSION_CONFLICT", "会計が更新されました。最新の状態を取得してください。", 409);
      const prepared = await prepareReceipt(tx, context, checkout, input);
      cashAssert(input.previewHash === prepared.previewHash, "RECEIPT_PREVIEW_CHANGED", "領収書の内容または発行者設定が変わりました。内容を確認し直してください。", 409);
      const { receipt, attachment } = prepared;
      // Persist the exact reviewed PDF bytes; retries never rerender a queued document.
      const payload = receiptPayloadSchema.parse({ checkoutId: id, requestId, requestHash, receipt, attachment, message: prepared.message });
      const item = await tx.emailOutbox.create({ data: { ...scope(context), eventType: RECEIPT_EVENT,
        eventKey, recipientEmail: input.recipientEmail, payload } });
      await operationAudit(tx, context, request, { action: "checkout.receipt.queue", resource: "cashCheckout", resourceId: id,
        metadata: { outboxId: item.id, receiptNumber: receipt.receiptNumber } });
      return historyEntry(item);
    });
    return reply.header("Cache-Control", "private, no-store").code(202).send(result);
  });
}
