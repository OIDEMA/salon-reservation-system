import { Prisma, type CustomerImportRun } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { hasPermission } from "./permissions.js";
import { lockOperation, operationAudit, operationError, requireOperationContext, runSerializable, type OperationContext } from "./operations-support.js";
import {
  CUSTOMER_IMPORT_BODY_LIMIT, CUSTOMER_IMPORT_CHUNK_SIZE, SALONBOARD_SOURCE_STORE, SALONBOARD_TARGET_TENANT,
  importChecksum, prepareSalonboardManifest, salonboardImportChunkSchema, salonboardRecordProfile
} from "./customer-import.js";

const paramsSchema = z.object({ id: z.string().min(1).max(160) });
const root = "/api/admin/customer-imports/salonboard";
type RequireContext = typeof requireOperationContext;
type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
function route(operation: Handler): Handler {
  return async (request, reply) => {
    try { return await operation(request, reply); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ code: "INVALID_IMPORT", message: error.issues[0]?.message ?? "移行データを確認してください。" });
      if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && [400, 403, 404, 409].includes(error.statusCode)) {
        return reply.code(error.statusCode).send({ code: "IMPORT_REJECTED", message: error.message });
      }
      request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError",
        errorCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined }, "customer import failed");
      return reply.code(500).send({ code: "IMPORT_FAILED", message: "移行処理を完了できませんでした。同じデータで再開できます。" });
    }
  };
}
function scoped(context: OperationContext) { return { tenantId: context.tenant.id, salonId: context.salon.id }; }
function assertTarget(context: OperationContext) {
  if (context.tenant.slug !== SALONBOARD_TARGET_TENANT) throw operationError(403, "この移行元はミスミセス高松店だけに取り込めます。");
}
function assertWriteAuthority(context: OperationContext) {
  if (!hasPermission(context, "chart.write")) throw operationError(403, "移行元のお客様メモを保存するにはカルテの編集権限が必要です。");
}
function summary(run: CustomerImportRun) {
  const processedCount = run.createdCount + run.skippedCount;
  return {
    id: run.id, source: run.source, sourceStoreId: run.sourceStoreId, expectedCount: run.expectedCount,
    chunkSize: CUSTOMER_IMPORT_CHUNK_SIZE, checksum: run.checksum, processedCount,
    createdCount: run.createdCount, skippedCount: run.skippedCount,
    remainingCount: run.expectedCount - processedCount, completed: processedCount === run.expectedCount,
    processedOffsets: run.processedOffsets.slice().sort((a, b) => a - b)
  };
}
async function scopedRun(tx: Prisma.TransactionClient, context: OperationContext, id: string) {
  const run = await tx.customerImportRun.findFirst({ where: { id, ...scoped(context), source: "SALONBOARD", sourceStoreId: SALONBOARD_SOURCE_STORE } });
  if (!run) throw operationError(404, "この店舗の移行処理が見つかりません。");
  return run;
}

/** Registered separately so the importer never bypasses normal authentication or scope. */
export async function registerCustomerImportRoutes(server: FastifyInstance, options: { requireContext?: RequireContext } = {}) {
  const requireContext = options.requireContext ?? requireOperationContext;
  server.post(`${root}/prepare`, { bodyLimit: CUSTOMER_IMPORT_BODY_LIMIT }, route(async (request, reply) => {
    const context = await requireContext(request, reply, "customer.write");
    if (!context) return;
    assertTarget(context); assertWriteAuthority(context);
    // Validate every row before creating even a manifest. No source values enter logs/audit.
    const { envelope, checksum, recordHashes } = prepareSalonboardManifest(request.body);
    const run = await runSerializable(async (tx) => {
      await lockOperation(tx, context, "customer.write");
      assertTarget(context); assertWriteAuthority(context);
      const existing = await tx.customerImportRun.findFirst({ where: { ...scoped(context), source: envelope.source, sourceStoreId: envelope.sourceStoreId, checksum } });
      if (existing) return existing;
      const created = await tx.customerImportRun.create({ data: {
        ...scoped(context), source: envelope.source, sourceStoreId: envelope.sourceStoreId,
        capturedAt: new Date(envelope.capturedAt), expectedCount: envelope.expectedCount, checksum, recordHashes, createdByUserId: context.user.id
      } });
      await operationAudit(tx, context, request, { action: "customer.import.prepare", resource: "customerImportRun", resourceId: created.id,
        metadata: { source: envelope.source, sourceStoreId: envelope.sourceStoreId, expectedCount: envelope.expectedCount, checksum } });
      return created;
    });
    return reply.header("Cache-Control", "private, no-store").send(summary(run));
  }));

  server.get(`${root}/:id`, route(async (request, reply) => {
    const context = await requireContext(request, reply, "customer.read");
    if (!context) return;
    assertTarget(context);
    const { id } = paramsSchema.parse(request.params);
    const run = await scopedRun(prisma, context, id);
    return reply.header("Cache-Control", "private, no-store").send(summary(run));
  }));

  server.post(`${root}/:id/chunks`, { bodyLimit: 2 * 1024 * 1024 }, route(async (request, reply) => {
    const context = await requireContext(request, reply, "customer.write");
    if (!context) return;
    assertTarget(context); assertWriteAuthority(context);
    const { id } = paramsSchema.parse(request.params);
    const input = salonboardImportChunkSchema.parse(request.body);
    const result = await runSerializable(async (tx) => {
      // The same tenant/salon lock orders access changes, imports and normal edits.
      await lockOperation(tx, context, "customer.write");
      assertTarget(context); assertWriteAuthority(context);
      const run = await scopedRun(tx, context, id);
      const count = Math.min(CUSTOMER_IMPORT_CHUNK_SIZE, run.expectedCount - input.offset);
      if (count <= 0 || input.records.length !== count ||
        input.records.some((record, index) => importChecksum(record) !== run.recordHashes[input.offset + index])) {
        throw operationError(400, "事前確認した移行データと一致しません。ファイルを選び直してください。");
      }
      if (run.processedOffsets.includes(input.offset)) {
        return { ...summary(run), chunk: { offset: input.offset, count, created: 0, skipped: 0, alreadyProcessed: true } };
      }
      let created = 0; let skipped = 0;
      for (const record of input.records) {
        const identity = { ...scoped(context), source: run.source, sourceStoreId: run.sourceStoreId, externalCustomerId: record.externalCustomerId };
        const mapped = await tx.customerExternalRecord.findUnique({ where: { tenantId_salonId_source_sourceStoreId_externalCustomerId: identity }, select: { id: true } });
        if (mapped) { skipped++; continue; }
        const profile = salonboardRecordProfile(record, run.capturedAt.toISOString());
        // Source history does not create local reservations, visits, revenue or chart entries.
        const customer = await tx.customer.create({ data: { ...scoped(context), name: record.name, kana: record.kana || record.name,
          phone: profile.phone, visitCount: 0, totalSpent: 0, lastVisitAt: null } });
        await tx.customerExternalRecord.create({ data: { ...identity, customerId: customer.id, profile } });
        created++;
      }
      const updated = await tx.customerImportRun.update({ where: { id: run.id }, data: {
        processedOffsets: { push: input.offset }, createdCount: { increment: created }, skippedCount: { increment: skipped },
        ...(run.createdCount + run.skippedCount + created + skipped === run.expectedCount ? { completedAt: new Date() } : {})
      } });
      await operationAudit(tx, context, request, { action: "customer.import.chunk", resource: "customerImportRun", resourceId: run.id,
        metadata: { source: run.source, sourceStoreId: run.sourceStoreId, checksum: run.checksum, offset: input.offset, count, created, skipped } });
      return { ...summary(updated), chunk: { offset: input.offset, count, created, skipped, alreadyProcessed: false } };
    });
    return reply.header("Cache-Control", "private, no-store").send(result);
  }));
}
