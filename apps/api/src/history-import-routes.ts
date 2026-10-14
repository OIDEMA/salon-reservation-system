import { Prisma, type HistoricalReservation, type HistoricalReservationImportRun } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { hasPermission } from "./permissions.js";
import { lockOperation, operationAudit, operationError, requireOperationContext, runSerializable, type OperationContext } from "./operations-support.js";
import { importChecksum } from "./customer-import.js";
import { staffPublicationKey } from "./staff-import.js";
import {
  HISTORY_IMPORT_BODY_LIMIT, HISTORY_IMPORT_CHUNK_SIZE, SALONBOARD_SOURCE_STORE, SALONBOARD_TARGET_TENANT,
  historyImportChunkSchema, historyJstMidnight, historyPageQuerySchema, nextHistoryDate, normalizedHistoryStatus, prepareHistoryManifest
} from "./history-import.js";

const paramsSchema = z.object({ id: z.string().min(1).max(160) });
const root = "/api/admin/history-imports/salonboard";
const historyRoot = "/api/admin/reservation-history";
type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
function safeRoute(handler: Handler): Handler {
  return async (request, reply) => {
    try { return await handler(request, reply); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ code: "INVALID_HISTORY", message: error.issues[0]?.message ?? "移行データ・検索条件を確認してください。" });
      if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && [400, 403, 404, 409].includes(error.statusCode)) return reply.code(error.statusCode).send({ code: "HISTORY_REJECTED", message: error.message });
      // Database errors may contain original source values. Never log the error object.
      request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError", errorCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined }, "historical reservation operation failed");
      return reply.code(500).send({ code: "HISTORY_FAILED", message: "処理を完了できませんでした。同じ移行データで再開できます。" });
    }
  };
}
function scope(context: OperationContext) { return { tenantId: context.tenant.id, salonId: context.salon.id }; }
function assertTarget(context: OperationContext) {
  if (context.tenant.slug !== SALONBOARD_TARGET_TENANT) throw operationError(403, "この移行元はミスミセス高松店だけに取り込めます。");
}
function assertWriteAuthority(context: OperationContext) {
  if (!hasPermission(context, "chart.write")) throw operationError(403, "元の予約メモを保存するにはカルテの編集権限が必要です。");
}
function summary(run: HistoricalReservationImportRun) {
  const processedCount = run.createdCount + run.skippedCount;
  return {
    id: run.id, source: run.source, sourceStoreId: run.sourceStoreId, expectedCount: run.expectedCount,
    chunkSize: HISTORY_IMPORT_CHUNK_SIZE, checksum: run.checksum, processedCount,
    createdCount: run.createdCount, skippedCount: run.skippedCount, remainingCount: run.expectedCount - processedCount,
    completed: processedCount === run.expectedCount, processedOffsets: run.processedOffsets.slice().sort((a, b) => a - b),
    periodFrom: run.periodFrom, periodTo: run.periodTo, monthCounts: run.monthCounts, statusCounts: run.statusCounts
  };
}
async function scopedRun(tx: Prisma.TransactionClient, context: OperationContext, id: string) {
  const run = await tx.historicalReservationImportRun.findFirst({ where: { id, ...scope(context), source: "SALONBOARD", sourceStoreId: SALONBOARD_SOURCE_STORE } });
  if (!run) throw operationError(404, "この店舗の移行処理が見つかりません。");
  return run;
}
const listSelect = {
  id: true, externalReservationId: true, startsAt: true, endsAt: true, durationMinutes: true,
  customerName: true, staffName: true, menuText: true, sourceStatus: true, normalizedStatus: true,
  reservationAmount: true, sourceRoute: true
} satisfies Prisma.HistoricalReservationSelect;
function listItem(record: Pick<HistoricalReservation, keyof typeof listSelect>) {
  return { ...record, startsAt: record.startsAt.toISOString(), endsAt: record.endsAt?.toISOString() ?? null };
}

/** Historical snapshots have no operational reservation, cash or chart write path. */
export async function registerHistoryImportRoutes(server: FastifyInstance, options: { requireContext?: typeof requireOperationContext } = {}) {
  const requireContext = options.requireContext ?? requireOperationContext;
  server.post(`${root}/prepare`, { bodyLimit: HISTORY_IMPORT_BODY_LIMIT }, safeRoute(async (request, reply) => {
    const context = await requireContext(request, reply, "reservation.write");
    if (!context) return;
    assertTarget(context); assertWriteAuthority(context);
    const { envelope, checksum, recordHashes, monthCounts, statusCounts } = prepareHistoryManifest(request.body);
    const run = await runSerializable(async (tx) => {
      await lockOperation(tx, context, "reservation.write");
      assertTarget(context); assertWriteAuthority(context);
      const existing = await tx.historicalReservationImportRun.findFirst({ where: { ...scope(context), source: envelope.source, sourceStoreId: envelope.sourceStoreId, checksum } });
      if (existing) return existing;
      const created = await tx.historicalReservationImportRun.create({ data: {
        ...scope(context), source: envelope.source, sourceStoreId: envelope.sourceStoreId, periodFrom: envelope.periodFrom, periodTo: envelope.periodTo,
        capturedAt: new Date(envelope.capturedAt), expectedCount: envelope.expectedCount, checksum, recordHashes,
        monthCounts, statusCounts, createdByUserId: context.user.id
      } });
      await operationAudit(tx, context, request, { action: "reservation.history.import.prepare", resource: "historicalReservationImportRun", resourceId: created.id,
        metadata: { source: envelope.source, sourceStoreId: envelope.sourceStoreId, expectedCount: envelope.expectedCount, checksum } });
      return created;
    });
    return reply.header("Cache-Control", "private, no-store").send(summary(run));
  }));
  server.get(`${root}/:id`, safeRoute(async (request, reply) => {
    const context = await requireContext(request, reply, "reservation.read");
    if (!context) return;
    assertTarget(context);
    const { id } = paramsSchema.parse(request.params);
    return reply.header("Cache-Control", "private, no-store").send(summary(await scopedRun(prisma, context, id)));
  }));
  server.post(`${root}/:id/chunks`, { bodyLimit: 6 * 1024 * 1024 }, safeRoute(async (request, reply) => {
    const context = await requireContext(request, reply, "reservation.write");
    if (!context) return;
    assertTarget(context); assertWriteAuthority(context);
    const { id } = paramsSchema.parse(request.params);
    const input = historyImportChunkSchema.parse(request.body);
    const result = await runSerializable(async (tx) => {
      await lockOperation(tx, context, "reservation.write");
      assertTarget(context); assertWriteAuthority(context);
      const run = await scopedRun(tx, context, id);
      const count = Math.min(HISTORY_IMPORT_CHUNK_SIZE, run.expectedCount - input.offset);
      if (count <= 0 || input.records.length !== count || input.records.some((record, index) => importChecksum(record) !== run.recordHashes[input.offset + index])) throw operationError(400, "事前確認した移行データと一致しません。ファイルを選び直してください。");
      if (run.processedOffsets.includes(input.offset)) return { ...summary(run), chunk: { offset: input.offset, count, created: 0, skipped: 0, alreadyProcessed: true } };
      let created = 0; let skipped = 0;
      for (const record of input.records) {
        const identity = { ...scope(context), source: run.source, sourceStoreId: run.sourceStoreId, externalReservationId: record.externalReservationId };
        const existing = await tx.historicalReservation.findFirst({ where: identity, select: { id: true } });
        if (existing) { skipped++; continue; }
        await tx.historicalReservation.create({ data: {
          ...identity, externalCustomerId: record.externalCustomerId, customerNumber: record.customerNumber, externalStaffId: record.externalStaffId,
          customerName: record.customerName, customerKana: record.customerKana, staffName: record.staffName,
          sourceStatus: record.sourceStatus, normalizedStatus: normalizedHistoryStatus(record.sourceStatus),
          startsAt: new Date(record.startsAt), endsAt: record.endsAt ? new Date(record.endsAt) : null, durationMinutes: record.durationMinutes,
          menuText: record.menuText, reservationAmount: record.reservationAmount, sourceRoute: record.sourceRoute,
          nominated: record.nominated, equipmentName: record.equipmentName, rawHeaders: record.rawHeaders, rawValues: record.rawValues,
          capturedAt: run.capturedAt
        } });
        created++;
      }
      const updated = await tx.historicalReservationImportRun.update({ where: { id: run.id }, data: {
        processedOffsets: { push: input.offset }, createdCount: { increment: created }, skippedCount: { increment: skipped },
        ...(run.createdCount + run.skippedCount + created + skipped === run.expectedCount ? { completedAt: new Date() } : {})
      } });
      await operationAudit(tx, context, request, { action: "reservation.history.import.chunk", resource: "historicalReservationImportRun", resourceId: run.id,
        metadata: { source: run.source, sourceStoreId: run.sourceStoreId, checksum: run.checksum, offset: input.offset, count, created, skipped } });
      return { ...summary(updated), chunk: { offset: input.offset, count, created, skipped, alreadyProcessed: false } };
    });
    return reply.header("Cache-Control", "private, no-store").send(result);
  }));

  server.get(`${historyRoot}/page`, safeRoute(async (request, reply) => {
    const context = await requireContext(request, reply, "reservation.read");
    if (!context) return;
    const query = historyPageQuerySchema.parse(request.query);
    const base = scope(context);
    const where: Prisma.HistoricalReservationWhereInput = {
      ...base, ...(query.sourceStatus ? { sourceStatus: query.sourceStatus } : {}),
      ...((query.from || query.to) ? { startsAt: {
        ...(query.from ? { gte: historyJstMidnight(query.from) } : {}),
        ...(query.to ? { lt: historyJstMidnight(nextHistoryDate(query.to)) } : {})
      } } : {}),
      ...(query.q ? { OR: ["customerName", "customerKana", "staffName", "menuText", "externalReservationId"].map((field) => ({ [field]: { contains: query.q, mode: "insensitive" } })) } : {})
    };
    const page = await prisma.$transaction(async (tx) => {
      const total = await tx.historicalReservation.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
      const currentPage = Math.min(query.page, totalPages);
      const rows = await tx.historicalReservation.findMany({ where, select: listSelect,
        orderBy: [{ startsAt: "desc" }, { id: "desc" }], skip: (currentPage - 1) * query.pageSize, take: query.pageSize });
      const statuses = await tx.historicalReservation.groupBy({ where: base, by: ["sourceStatus"], orderBy: { sourceStatus: "asc" } });
      return { items: rows.map(listItem), page: currentPage, pageSize: query.pageSize, total, totalPages, statusOptions: statuses.map((value) => value.sourceStatus) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return reply.header("Cache-Control", "private, no-store").send(page);
  }));
  server.get(`${historyRoot}/:id`, safeRoute(async (request, reply) => {
    const context = await requireContext(request, reply, "reservation.read");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const canReadOriginal = hasPermission(context, "chart.read");
    const record = await prisma.historicalReservation.findFirst({ where: { id, ...scope(context) }, select: {
      ...listSelect, source: true, sourceStoreId: true, externalCustomerId: true, customerNumber: true, externalStaffId: true, staffId: true,
      customerKana: true, nominated: true, equipmentName: true, capturedAt: true, importedAt: true,
      ...(canReadOriginal ? { rawHeaders: true, rawValues: true } : {})
    } });
    if (!record) throw operationError(404, "この店舗の予約履歴が見つかりません。");
    // Fixed source IDs only. Customer/staff names and telephone numbers never create links.
    const [customer, staff] = await Promise.all([
      record.externalCustomerId ? prisma.customerExternalRecord.findFirst({ where: {
        ...scope(context), source: record.source, sourceStoreId: record.sourceStoreId, externalCustomerId: record.externalCustomerId
      }, select: { customerId: true } }) : null,
      record.externalStaffId ? prisma.staffExternalRecord.findFirst({ where: {
        ...scope(context), source: record.source, sourceStoreId: record.sourceStoreId, externalRecordKey: staffPublicationKey(record.sourceStoreId, record.externalStaffId)
      }, select: { staffId: true } }) : null
    ]);
    return reply.header("Cache-Control", "private, no-store").send({ ...listItem(record),
      capturedAt: record.capturedAt.toISOString(), importedAt: record.importedAt.toISOString(),
      customerId: customer?.customerId ?? null, staffId: record.staffId ?? staff?.staffId ?? null, canReadOriginal
    });
  }));
}
