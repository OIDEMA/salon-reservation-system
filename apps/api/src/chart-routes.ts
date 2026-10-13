import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import {
  assertChartDraft, assertChartFinalizable, assertChartVersion, ChartError,
  chartAmendSchema, chartCreateSchema, chartFieldData, chartUpdateSchema, chartVersionSchema,
  MAX_CHART_PHOTO_BYTES, MAX_CHART_PHOTOS, normalizeChartPhoto
} from "./chart-domain.js";
import { lockOperation, operationAudit, requireOperationContext, runSerializable, type OperationContext } from "./operations-support.js";
import { chartPhotoObjectReference, chartPhotoStorage, type ChartPhotoObject, type ChartPhotoStorage } from "./chart-photo-storage.js";
import { cleanupUnreferencedChartPhotos } from "./chart-photo-cleanup.js";

const idSchema = z.string().min(1).max(160);
const idParams = z.object({ id: idSchema });
const photoParams = idParams.extend({ photoId: idSchema });
const listQuery = z.object({ customerId: idSchema.optional(), reservationId: idSchema.optional(), cursor: idSchema.optional() }).strict();
const optionsQuery = z.object({ query: z.string().trim().max(120).optional() }).strict();
const photoQuery = z.object({
  expectedVersion: z.coerce.number().int().min(1).max(2_000_000_000),
  phase: z.enum(["BEFORE", "AFTER"])
}).strict();

const photoFieldsSchema = z.object({
  bodyPart: z.string().trim().max(120).optional(),
  note: z.string().trim().max(1000).optional(),
  capturedAt: z.string().datetime({ offset: true }).optional()
}).strict();

function photoFields(header: string | string[] | undefined) {
  if (header === undefined) return {};
  if (typeof header !== "string" || header.length > 7000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) {
    throw new ChartError("CHART_PHOTO_METADATA_INVALID", "写真の撮影日時・部位・メモを確認してください。");
  }
  try {
    const parsed = photoFieldsSchema.parse(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
    return { bodyPart: parsed.bodyPart || null, note: parsed.note || null, capturedAt: parsed.capturedAt ? new Date(parsed.capturedAt) : null };
  } catch {
    throw new ChartError("CHART_PHOTO_METADATA_INVALID", "写真の撮影日時・部位・メモを確認してください。");
  }
}

function isCertainRollback(error: unknown) {
  return error instanceof ChartError || error instanceof z.ZodError ||
    error instanceof Error && "statusCode" in error && [403, 404].includes(Number(error.statusCode)) ||
    error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2003", "P2034"].includes(error.code);
}

// This selection is shared by every JSON response. Image bytes and storage locations are deliberately absent.
const photoMetadataSelect = {
  id: true, phase: true, mimeType: true, width: true, height: true, byteSize: true, createdAt: true,
  bodyPart: true, note: true, capturedAt: true
} satisfies Prisma.TreatmentChartPhotoSelect;
const detailInclude = {
  reservation: { select: { status: true } },
  revisions: {
    orderBy: { revisionNumber: "desc" as const },
    include: { photoLinks: { select: { photo: { select: photoMetadataSelect } } } }
  }
} satisfies Prisma.TreatmentChartInclude;
const summaryInclude = {
  revisions: { orderBy: { revisionNumber: "desc" as const }, take: 1, include: { _count: { select: { photoLinks: true } } } }
} satisfies Prisma.TreatmentChartInclude;
const reservationInclude = {
  customer: { select: { id: true, name: true } },
  staff: { select: { id: true, name: true } },
  service: { select: { id: true, name: true } },
  treatmentCharts: { select: { id: true } }
} satisfies Prisma.ReservationInclude;

type ChartDetailRecord = Prisma.TreatmentChartGetPayload<{ include: typeof detailInclude }>;
type ChartSummaryRecord = Prisma.TreatmentChartGetPayload<{ include: typeof summaryInclude }>;
type ReservationRecord = Prisma.ReservationGetPayload<{ include: typeof reservationInclude }>;
type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function scoped(context: OperationContext) {
  return { tenantId: context.tenant.id, salonId: context.salon.id };
}

function actorName(context: OperationContext) {
  return context.user.displayName?.trim() || "スタッフ";
}

function jsonSummary(chart: ChartSummaryRecord | ChartDetailRecord, timezone: string) {
  const current = chart.revisions.find((revision) => revision.revisionNumber === chart.currentRevisionNumber);
  if (!current) throw new Error("Treatment chart current revision is missing");
  const photoCount = "photoLinks" in current ? current.photoLinks.length : current._count.photoLinks;
  return {
    id: chart.id, reservationId: chart.reservationId, customerId: chart.customerId,
    customerName: chart.customerName, staffId: chart.staffId, staffName: chart.staffName,
    serviceName: chart.serviceName, startsAt: chart.startsAt.toISOString(), endsAt: chart.endsAt.toISOString(),
    treatmentAt: current.treatmentAt.toISOString(), currentRevisionNumber: chart.currentRevisionNumber,
    version: chart.version, status: current.status, updatedAt: chart.updatedAt.toISOString(), photoCount, timezone
  };
}

function jsonDetail(chart: ChartDetailRecord, timezone: string) {
  return {
    ...jsonSummary(chart, timezone),
    reservation: {
      id: chart.reservationId, startsAt: chart.startsAt.toISOString(), endsAt: chart.endsAt.toISOString(),
      status: chart.reservation.status, customer: { id: chart.customerId, name: chart.customerName },
      staff: chart.staffId ? { id: chart.staffId, name: chart.staffName ?? "担当者" } : null,
      service: { id: chart.serviceId, name: chart.serviceName }
    },
    revisions: chart.revisions.map((revision) => ({
      id: revision.id, revisionNumber: revision.revisionNumber, status: revision.status,
      treatmentAt: revision.treatmentAt.toISOString(), bodyParts: revision.bodyParts,
      performedServiceDetail: revision.performedServiceDetail, machine: revision.machine,
      outputJ: revision.outputJ, pulseWidth: revision.pulseWidth, skinObservations: revision.skinObservations,
      productsMaterials: revision.productsMaterials, aftercareNotes: revision.aftercareNotes,
      nextVisitPlan: revision.nextVisitPlan, amendmentReason: revision.amendmentReason,
      createdAt: revision.createdAt.toISOString(), updatedAt: revision.updatedAt.toISOString(),
      finalizedAt: revision.finalizedAt?.toISOString() ?? null,
      createdByName: revision.createdByName, finalizedByName: revision.finalizedByName,
      photos: revision.photoLinks.map(({ photo }) => ({ ...photo, createdAt: photo.createdAt.toISOString(), capturedAt: photo.capturedAt?.toISOString() ?? null }))
    }))
  };
}

function jsonReservation(reservation: ReservationRecord, timezone: string) {
  return {
    id: reservation.id, startsAt: reservation.startsAt.toISOString(), endsAt: reservation.endsAt.toISOString(),
    status: reservation.status, customer: reservation.customer, staff: reservation.staff,
    service: reservation.service, chartId: reservation.treatmentCharts[0]?.id ?? null, timezone
  };
}

function handler(operation: Handler): Handler {
  return async (request, reply) => {
    // Clinical text and image data must not be printed by the shared error logger.
    try { return await operation(request, reply); }
    catch (error) {
      if (error instanceof ChartError) {
        return reply.code(error.statusCode).send({ code: error.code, message: error.message, ...(error.chartId ? { chartId: error.chartId } : {}) });
      }
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ code: "INVALID_INPUT", message: error.issues[0]?.message ?? "入力内容を確認してください。" });
      }
      if (error instanceof Error && "statusCode" in error &&
        typeof error.statusCode === "number" && [403, 404].includes(error.statusCode)) {
        return reply.code(error.statusCode).send({ code: "OPERATION_REJECTED", message: error.message });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)))) {
        return reply.code(409).send({ code: "CHART_CONFLICT", message: "別の操作と更新が重なりました。最新のカルテを読み直してください。" });
      }
      request.log.error({
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined
      }, "chart request failed");
      return reply.code(500).send({ code: "CHART_REQUEST_FAILED", message: "カルテを処理できませんでした。時間をおいて再度お試しください。" });
    }
  };
}

async function findDetail(tx: Prisma.TransactionClient, context: OperationContext, id: string) {
  const chart = await tx.treatmentChart.findFirst({ where: { ...scoped(context), id }, include: detailInclude });
  if (!chart) throw new ChartError("CHART_NOT_FOUND", "カルテが見つかりません。", 404);
  return chart;
}

async function findCurrent(tx: Prisma.TransactionClient, context: OperationContext, id: string, expectedVersion: number) {
  const chart = await tx.treatmentChart.findFirst({
    where: { ...scoped(context), id },
    include: { revisions: { orderBy: { revisionNumber: "desc" }, take: 1 } }
  });
  if (!chart) throw new ChartError("CHART_NOT_FOUND", "カルテが見つかりません。", 404);
  assertChartVersion(chart.version, expectedVersion);
  const revision = chart.revisions[0];
  if (!revision || revision.revisionNumber !== chart.currentRevisionNumber) throw new Error("Treatment chart current revision is missing");
  return { chart, revision };
}

async function bumpVersion(tx: Prisma.TransactionClient, context: OperationContext, id: string, expectedVersion: number, currentRevisionNumber?: number) {
  const result = await tx.treatmentChart.updateMany({
    where: { ...scoped(context), id, version: expectedVersion },
    data: { version: { increment: 1 }, ...(currentRevisionNumber ? { currentRevisionNumber } : {}) }
  });
  if (result.count !== 1) assertChartVersion(-1, expectedVersion);
}

export async function registerChartRoutes(server: FastifyInstance, dependencies: {
  requireContext?: typeof requireOperationContext; photoStorage?: ChartPhotoStorage;
} = {}) {
  const requireContext = dependencies.requireContext ?? requireOperationContext;
  const storage = dependencies.photoStorage ?? chartPhotoStorage;
  await server.register(async (routes) => {
    // Encapsulated binary parser: unrelated API requests keep their existing parser/limits.
    routes.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: MAX_CHART_PHOTO_BYTES }, (_request, body, done) => done(null, body));
    routes.addHook("onSend", async (_request, reply) => {
      reply.header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff");
    });

    routes.get("/api/charts", handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.read");
      if (!context) return;
      const query = listQuery.parse(request.query);
      const where = { ...scoped(context), ...(query.customerId ? { customerId: query.customerId } : {}), ...(query.reservationId ? { reservationId: query.reservationId } : {}) };
      if (query.cursor && !await prisma.treatmentChart.findFirst({ where: { ...where, id: query.cursor }, select: { id: true } })) {
        throw new ChartError("CHART_CURSOR_INVALID", "一覧を更新して、再度読み込んでください。", 400);
      }
      const rows = await prisma.treatmentChart.findMany({
        where, include: summaryInclude, orderBy: [{ startsAt: "desc" }, { id: "desc" }], take: 51,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {})
      });
      const page = rows.slice(0, 50);
      return { charts: page.map((chart) => jsonSummary(chart, context.salon.timezone)), nextCursor: rows.length > 50 ? page.at(-1)!.id : null };
    }));

    routes.get("/api/charts/reservation-options", handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.read");
      if (!context) return;
      const { query } = optionsQuery.parse(request.query);
      const reservations = await prisma.reservation.findMany({
        where: {
          ...scoped(context), ...(query ? { OR: [
            { customer: { name: { contains: query, mode: "insensitive" as const } } },
            { customer: { kana: { contains: query, mode: "insensitive" as const } } },
            { service: { name: { contains: query, mode: "insensitive" as const } } }
          ] } : {})
        },
        include: reservationInclude, orderBy: [{ startsAt: "desc" }, { id: "desc" }], take: 50
      });
      return { reservations: reservations.map((reservation) => jsonReservation(reservation, context.salon.timezone)) };
    }));

    routes.get("/api/charts/reservation-context/:id", handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.read");
      if (!context) return;
      const { id } = idParams.parse(request.params);
      const reservation = await prisma.reservation.findFirst({ where: { ...scoped(context), id }, include: reservationInclude });
      if (!reservation) throw new ChartError("RESERVATION_NOT_FOUND", "予約が見つかりません。", 404);
      return jsonReservation(reservation, context.salon.timezone);
    }));

    routes.post("/api/charts", handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.write");
      if (!context) return;
      const { reservationId, ...fields } = chartCreateSchema.parse(request.body);
      try {
        const chart = await runSerializable(async (tx) => {
          // Recheck authority after the shared access/reservation locks have been acquired.
          await lockOperation(tx, context, "chart.write");
          const reservation = await tx.reservation.findFirst({ where: { ...scoped(context), id: reservationId }, include: reservationInclude });
          if (!reservation) throw new ChartError("RESERVATION_NOT_FOUND", "予約が見つかりません。", 404);
          if (reservation.treatmentCharts[0]) throw new ChartError("CHART_EXISTS", "この予約にはすでにカルテがあります。", 409, reservation.treatmentCharts[0].id);
          const created = await tx.treatmentChart.create({ data: {
            ...scoped(context), reservationId, customerId: reservation.customerId, staffId: reservation.staffId,
            customerName: reservation.customer.name, staffName: reservation.staff?.name ?? null,
            serviceId: reservation.serviceId, serviceName: reservation.service.name,
            startsAt: reservation.startsAt, endsAt: reservation.endsAt
          } });
          await tx.treatmentChartRevision.create({ data: {
            ...scoped(context), chartId: created.id, revisionNumber: 1, ...chartFieldData(fields),
            createdByUserId: context.user.id, createdByName: actorName(context)
          } });
          await operationAudit(tx, context, request, { action: "chart.created", resource: "TreatmentChart", resourceId: created.id, metadata: { revisionNumber: 1 } });
          return findDetail(tx, context, created.id);
        });
        return reply.code(201).send(jsonDetail(chart, context.salon.timezone));
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const existing = await prisma.treatmentChart.findFirst({ where: { ...scoped(context), reservationId }, select: { id: true } });
          if (existing) throw new ChartError("CHART_EXISTS", "この予約にはすでにカルテがあります。", 409, existing.id);
        }
        throw error;
      }
    }));

    routes.get("/api/charts/:id", handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.read");
      if (!context) return;
      const { id } = idParams.parse(request.params);
      const chart = await findDetail(prisma, context, id);
      await operationAudit(prisma, context, request, { action: "chart.viewed", resource: "TreatmentChart", resourceId: id });
      return jsonDetail(chart, context.salon.timezone);
    }));

    routes.patch("/api/charts/:id/draft", handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.write");
      if (!context) return;
      const { id } = idParams.parse(request.params);
      const { expectedVersion, ...fields } = chartUpdateSchema.parse(request.body);
      const result = await runSerializable(async (tx) => {
        await lockOperation(tx, context, "chart.write");
        const { revision } = await findCurrent(tx, context, id, expectedVersion);
        assertChartDraft(revision.status);
        await bumpVersion(tx, context, id, expectedVersion);
        const updated = await tx.treatmentChartRevision.updateMany({
          where: { ...scoped(context), chartId: id, id: revision.id, status: "DRAFT" }, data: chartFieldData(fields)
        });
        if (updated.count !== 1) assertChartDraft("FINALIZED");
        await operationAudit(tx, context, request, { action: "chart.draft_updated", resource: "TreatmentChart", resourceId: id, metadata: { revisionNumber: revision.revisionNumber } });
        return findDetail(tx, context, id);
      });
      return jsonDetail(result, context.salon.timezone);
    }));

    routes.post("/api/charts/:id/finalize", handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.write");
      if (!context) return;
      const { id } = idParams.parse(request.params);
      const { expectedVersion } = chartVersionSchema.parse(request.body);
      const result = await runSerializable(async (tx) => {
        await lockOperation(tx, context, "chart.write");
        const { revision } = await findCurrent(tx, context, id, expectedVersion);
        assertChartDraft(revision.status);
        assertChartFinalizable(revision);
        await bumpVersion(tx, context, id, expectedVersion);
        const updated = await tx.treatmentChartRevision.updateMany({
          where: { ...scoped(context), chartId: id, id: revision.id, status: "DRAFT" },
          data: { status: "FINALIZED", finalizedAt: new Date(), finalizedByUserId: context.user.id, finalizedByName: actorName(context) }
        });
        if (updated.count !== 1) assertChartDraft("FINALIZED");
        await operationAudit(tx, context, request, { action: "chart.finalized", resource: "TreatmentChart", resourceId: id, metadata: { revisionNumber: revision.revisionNumber } });
        return findDetail(tx, context, id);
      });
      return jsonDetail(result, context.salon.timezone);
    }));

    routes.post("/api/charts/:id/amend", handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.write");
      if (!context) return;
      const { id } = idParams.parse(request.params);
      const { expectedVersion, reason } = chartAmendSchema.parse(request.body);
      const result = await runSerializable(async (tx) => {
        await lockOperation(tx, context, "chart.write");
        const { chart, revision } = await findCurrent(tx, context, id, expectedVersion);
        if (revision.status !== "FINALIZED") throw new ChartError("CHART_DRAFT_EXISTS", "現在の下書きを確定してから訂正してください。", 409);
        const revisionNumber = chart.currentRevisionNumber + 1;
        await bumpVersion(tx, context, id, expectedVersion, revisionNumber);
        const next = await tx.treatmentChartRevision.create({ data: {
          ...scoped(context), chartId: id, revisionNumber, status: "DRAFT", amendmentReason: reason,
          createdByUserId: context.user.id, createdByName: actorName(context),
          treatmentAt: revision.treatmentAt, bodyParts: revision.bodyParts,
          performedServiceDetail: revision.performedServiceDetail, machine: revision.machine,
          outputJ: revision.outputJ, pulseWidth: revision.pulseWidth, skinObservations: revision.skinObservations,
          productsMaterials: revision.productsMaterials, aftercareNotes: revision.aftercareNotes, nextVisitPlan: revision.nextVisitPlan
        } });
        const photoLinks = await tx.treatmentChartRevisionPhoto.findMany({ where: { ...scoped(context), chartId: id, revisionId: revision.id }, select: { photoId: true } });
        if (photoLinks.length) await tx.treatmentChartRevisionPhoto.createMany({ data: photoLinks.map(({ photoId }) => ({ ...scoped(context), chartId: id, revisionId: next.id, photoId })) });
        await operationAudit(tx, context, request, { action: "chart.amendment_started", resource: "TreatmentChart", resourceId: id, metadata: { revisionNumber, previousRevisionNumber: revision.revisionNumber } });
        return findDetail(tx, context, id);
      });
      return jsonDetail(result, context.salon.timezone);
    }));

    routes.post("/api/charts/:id/photos", { bodyLimit: MAX_CHART_PHOTO_BYTES }, handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.write");
      if (!context) return;
      const { id } = idParams.parse(request.params);
      const { expectedVersion, phase } = photoQuery.parse(request.query);
      const fields = photoFields(request.headers["x-chart-photo-metadata"]);
      // Check scope/status before processing, then recheck fresh authority under the transaction lock.
      const preview = await findCurrent(prisma, context, id, expectedVersion);
      assertChartDraft(preview.revision.status);
      const currentCount = await prisma.treatmentChartRevisionPhoto.count({ where: { ...scoped(context), chartId: id, revisionId: preview.revision.id } });
      if (currentCount >= MAX_CHART_PHOTOS) throw new ChartError("CHART_PHOTO_LIMIT", "写真は1つの版につき10枚まで保存できます。");
      if (!Buffer.isBuffer(request.body)) throw new ChartError("CHART_PHOTO_TYPE", "JPEG・PNG・WebPの写真を選択してください。", 415);
      const { data, ...photo } = await normalizeChartPhoto(request.body, request.headers["content-type"] ?? "");
      const photoId = randomUUID();
      // Upload once outside the retryable transaction; no public URL or token is created.
      let object: ChartPhotoObject;
      try {
        object = await storage.put({ ...scoped(context), chartId: id, photoId, data, mimeType: photo.mimeType });
      } catch (error) {
        // A lost cloud response may leave a private object; retain an opaque correlation ID
        // for the read-only storage audit. Never log the photo, notes, credentials or URL.
        if (error instanceof ChartError && error.code === "CHART_PHOTO_STORAGE_UNAVAILABLE") {
          request.log.warn({ photoId, chartId: id }, "chart photo upload outcome requires reconciliation");
        }
        throw error;
      }
      let result: ChartDetailRecord;
      try {
        result = await runSerializable(async (tx) => {
          await lockOperation(tx, context, "chart.write");
          const { revision } = await findCurrent(tx, context, id, expectedVersion);
          assertChartDraft(revision.status);
          const count = await tx.treatmentChartRevisionPhoto.count({ where: { ...scoped(context), chartId: id, revisionId: revision.id } });
          if (count >= MAX_CHART_PHOTOS) throw new ChartError("CHART_PHOTO_LIMIT", "写真は1つの版につき10枚まで保存できます。");
          await bumpVersion(tx, context, id, expectedVersion);
          const created = await tx.treatmentChartPhoto.create({ data: { ...scoped(context), chartId: id, id: photoId, phase, ...photo, ...fields, ...object } });
          await tx.treatmentChartRevisionPhoto.create({ data: { ...scoped(context), chartId: id, revisionId: revision.id, photoId: created.id } });
          await operationAudit(tx, context, request, { action: "chart.photo_added", resource: "TreatmentChartPhoto", resourceId: created.id, metadata: { chartId: id, revisionNumber: revision.revisionNumber, phase } });
          return findDetail(tx, context, id);
        });
      } catch (error) {
        // Never clean up on a timeout/connection error with an ambiguous commit outcome.
        // For a definite rollback, record a tombstone only if the photo is independently absent.
        if (isCertainRollback(error)) {
          try {
            if (!await prisma.treatmentChartPhoto.findUnique({ where: { id: photoId }, select: { id: true } })) {
              await prisma.treatmentChartPhoto.create({ data: {
                ...scoped(context), chartId: id, id: photoId, phase, ...photo, ...object,
                storageDeletePendingAt: new Date()
              } });
              await cleanupUnreferencedChartPhotos(scoped(context), storage);
            }
          } catch { request.log.warn({ photoId }, "chart photo cleanup pending after rejected upload"); }
        } else {
          request.log.warn({ photoId }, "chart photo upload commit outcome requires reconciliation");
        }
        throw error;
      }
      // Retry prior failed draft deletions without failing a successfully committed upload.
      try { await cleanupUnreferencedChartPhotos(scoped(context), storage, 5); } catch { /* Next mutation retries. */ }
      return reply.code(201).send(jsonDetail(result, context.salon.timezone));
    }));

    routes.delete("/api/charts/:id/photos/:photoId", handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.write");
      if (!context) return;
      const { id, photoId } = photoParams.parse(request.params);
      const { expectedVersion } = chartVersionSchema.parse(request.body);
      const result = await runSerializable(async (tx) => {
        await lockOperation(tx, context, "chart.write");
        const { revision } = await findCurrent(tx, context, id, expectedVersion);
        assertChartDraft(revision.status);
        const where = { ...scoped(context), chartId: id, revisionId: revision.id, photoId };
        if (!await tx.treatmentChartRevisionPhoto.findFirst({ where, select: { photoId: true } })) throw new ChartError("CHART_PHOTO_NOT_FOUND", "写真が見つかりません。", 404);
        await bumpVersion(tx, context, id, expectedVersion);
        await tx.treatmentChartRevisionPhoto.deleteMany({ where });
        // Earlier finalized versions retain their photographs. An unreferenced draft photo
        // becomes inaccessible immediately; keep metadata until cloud deletion succeeds.
        await tx.treatmentChartPhoto.updateMany({
          where: { ...scoped(context), chartId: id, id: photoId, revisionLinks: { none: {} } },
          data: { storageDeletePendingAt: new Date() }
        });
        await operationAudit(tx, context, request, { action: "chart.photo_removed_from_draft", resource: "TreatmentChartPhoto", resourceId: photoId, metadata: { chartId: id, revisionNumber: revision.revisionNumber } });
        return findDetail(tx, context, id);
      });
      try { await cleanupUnreferencedChartPhotos(scoped(context), storage); } catch { /* Tombstones remain retryable. */ }
      return jsonDetail(result, context.salon.timezone);
    }));

    routes.get("/api/charts/:id/photos/:photoId", handler(async (request, reply) => {
      const context = await requireContext(request, reply, "chart.read");
      if (!context) return;
      const { id, photoId } = photoParams.parse(request.params);
      const photo = await prisma.treatmentChartPhoto.findFirst({
        where: { ...scoped(context), chartId: id, id: photoId, revisionLinks: { some: { ...scoped(context), chartId: id } } },
        select: { data: true, mimeType: true, storageBucket: true, storagePath: true, storageGeneration: true }
      });
      if (!photo) throw new ChartError("CHART_PHOTO_NOT_FOUND", "写真が見つかりません。", 404);
      const object = chartPhotoObjectReference(photo);
      const bytes = object ? await storage.read(object) : photo.data ? Buffer.from(photo.data) : null;
      if (!bytes) throw new ChartError("CHART_PHOTO_STORAGE_UNAVAILABLE", "写真を読み込めません。管理者にお問い合わせください。", 503);
      await operationAudit(prisma, context, request, { action: "chart.photo_viewed", resource: "TreatmentChartPhoto", resourceId: photoId, metadata: { chartId: id } });
      return reply.header("Content-Security-Policy", "default-src 'none'; sandbox").type(photo.mimeType).send(bytes);
    }));
  });
}
