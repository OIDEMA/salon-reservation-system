import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { lockOperation, operationAudit, operationError, requireOperationContext, runSerializable } from "./operations-support.js";
import { STAFF_IMPORT_BODY_LIMIT, STAFF_IMPORT_TARGET_TENANT, prepareStaffImport } from "./staff-import.js";

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const paramsSchema = z.object({ id: z.string().min(1).max(160) });
function safeRoute(handler: Handler): Handler {
  return async (request, reply) => {
    try { return await handler(request, reply); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ code: "INVALID_IMPORT", message: error.issues[0]?.message ?? "移行データを確認してください。" });
      if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && [400, 403, 404, 409].includes(error.statusCode)) {
        return reply.code(error.statusCode).send({ code: "IMPORT_REJECTED", message: error.message });
      }
      request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError", errorCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined }, "staff operation failed");
      return reply.code(500).send({ code: "STAFF_OPERATION_FAILED", message: "処理を完了できませんでした。同じ移行データで再試行できます。" });
    }
  };
}
export async function registerStaffImportRoutes(server: FastifyInstance, options: { requireContext?: typeof requireOperationContext } = {}) {
  const requireContext = options.requireContext ?? requireOperationContext;
  server.post("/api/admin/staff-imports/salonboard", { bodyLimit: STAFF_IMPORT_BODY_LIMIT }, safeRoute(async (request, reply) => {
    const context = await requireContext(request, reply, "master.write");
    if (!context) return;
    if (context.tenant.slug !== STAFF_IMPORT_TARGET_TENANT) throw operationError(403, "この移行元はミスミセス高松店だけに取り込めます。");
    // The complete bounded snapshot is validated before the first database write.
    const { envelope, checksum } = prepareStaffImport(request.body);
    const scope = { tenantId: context.tenant.id, salonId: context.salon.id };
    const result = await runSerializable(async (tx) => {
      await lockOperation(tx, context, "master.write");
      if (context.tenant.slug !== STAFF_IMPORT_TARGET_TENANT) throw operationError(403, "この移行元はミスミセス高松店だけに取り込めます。");
      let createdCount = 0; let skippedCount = 0;
      for (const record of envelope.records) {
        const identity = { ...scope, source: envelope.source, sourceStoreId: envelope.sourceStoreId, externalRecordKey: record.externalRecordKey };
        const mapped = await tx.staffExternalRecord.findUnique({ where: { tenantId_salonId_source_sourceStoreId_externalRecordKey: identity }, select: { id: true } });
        if (mapped) { skippedCount++; continue; }
        const staff = await tx.staff.create({ data: {
          ...scope, name: record.name, kana: record.kana, role: record.role, color: "#18c7bd", nominationFee: record.nominationFee ?? 0, comment: record.comment ?? null,
          parallelCapacity: record.parallelCapacity, allocationOrder: record.allocationOrder, sortOrder: record.sortOrder, active: record.active
        } });
        await tx.staffExternalRecord.create({ data: { ...identity, staffId: staff.id, profile: {
          version: 1, capturedAt: envelope.capturedAt, identityKind: record.publicationStaffId ? "SOURCE_PUBLICATION_STAFF_ID" : "SOURCE_NAME_KANA_SNAPSHOT",
          publicationStaffId: record.publicationStaffId ?? null, name: record.name, kana: record.kana,
          sourceProfile: record.profile, unconfirmedDefaults: { ...(record.nominationFee === undefined ? { nominationFee: 0 } : {}), bookingColor: "#18c7bd" }
        } } });
        createdCount++;
      }
      await operationAudit(tx, context, request, { action: "staff.import", resource: "staff", resourceId: context.salon.id,
        metadata: { source: envelope.source, sourceStoreId: envelope.sourceStoreId, expectedCount: envelope.expectedCount, createdCount, skippedCount, checksum } });
      return { source: envelope.source, sourceStoreId: envelope.sourceStoreId, expectedCount: envelope.expectedCount, createdCount, skippedCount, checksum };
    });
    return reply.header("Cache-Control", "private, no-store").send(result);
  }));

  server.get("/api/admin/staff/next-sort", safeRoute(async (request, reply) => {
    const context = await requireContext(request, reply, "master.write");
    if (!context) return;
    const maximum = await prisma.staff.aggregate({ where: { tenantId: context.tenant.id, salonId: context.salon.id }, _max: { sortOrder: true } });
    return reply.header("Cache-Control", "private, no-store").send({ sortOrder: Math.max(0, (maximum._max.sortOrder ?? -1) + 1) });
  }));
  server.get("/api/admin/staff/:id", safeRoute(async (request, reply) => {
    const context = await requireContext(request, reply, "master.read");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const staff = await prisma.staff.findFirst({ where: { id, tenantId: context.tenant.id, salonId: context.salon.id },
      include: { externalRecords: { orderBy: { importedAt: "asc" }, select: { source: true, sourceStoreId: true, profile: true, importedAt: true } } } });
    if (!staff) throw operationError(404, "この店舗のスタッフが見つかりません。");
    const { externalRecords, ...details } = staff;
    return reply.header("Cache-Control", "private, no-store").send({ ...details, sourceRecords: externalRecords });
  }));
}
