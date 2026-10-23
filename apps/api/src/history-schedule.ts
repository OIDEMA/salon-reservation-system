import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { hasPermission } from "./permissions.js";
import { lockOperation, operationAudit, operationError, requireOperationContext, runSerializable } from "./operations-support.js";

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "日付を確認してください。");
export const historyScheduleInputSchema = z.object({
  date: calendarDate,
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  staffId: z.string().min(1).max(160).nullable(),
  expectedVersion: z.number().int().min(0).max(2_147_483_646)
}).strict();
const paramsSchema = z.object({ id: z.string().min(1).max(160) });

type Schedule = { startsAt: Date; endsAt: Date | null; staffId: string | null };
/** Moving an unknown end never supplies a guessed duration; overnight intervals retain their length. */
export function moveHistoricalSchedule(previous: Schedule, input: z.infer<typeof historyScheduleInputSchema>): Schedule {
  const startsAt = new Date(`${input.date}T${input.startTime}:00+09:00`);
  const duration = previous.endsAt ? previous.endsAt.getTime() - previous.startsAt.getTime() : null;
  if (duration !== null && duration <= 0) throw operationError(400, "予約時間を確認してください。");
  return { startsAt, endsAt: duration === null ? null : new Date(startsAt.getTime() + duration), staffId: input.staffId };
}

function scheduleResponse(id: string, schedule: Schedule, staffName: string | null, version: number) {
  return { id, startsAt: schedule.startsAt.toISOString(), endsAt: schedule.endsAt?.toISOString() ?? null,
    rowId: schedule.staffId ?? "unassigned", staffName, scheduleVersion: version };
}

/** Only the explicitly editable placement changes. Imported snapshots and operational reservations are never written. */
export async function registerHistoryScheduleRoutes(server: FastifyInstance, options: { requireContext?: typeof requireOperationContext } = {}) {
  const requireContext = options.requireContext ?? requireOperationContext;
  server.patch("/api/admin/reservation-history/:id/schedule", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const context = await requireContext(request, reply, "reservation.write");
      if (!context) return;
      if (!hasPermission(context, "reservation.read")) throw operationError(403, "予約を閲覧する権限が必要です。");
      const { id } = paramsSchema.parse(request.params);
      const input = historyScheduleInputSchema.parse(request.body);
      const scope = { tenantId: context.tenant.id, salonId: context.salon.id };
      const result = await runSerializable(async (tx) => {
        await lockOperation(tx, context, "reservation.write");
        if (!hasPermission(context, "reservation.read")) throw operationError(403, "予約を閲覧する権限が必要です。");
        const record = await tx.historicalReservation.findFirst({ where: { ...scope, id }, select: {
          id: true, startsAt: true, endsAt: true, staffId: true, scheduleOverride: true
        } });
        if (!record) throw operationError(404, "この店舗の予約履歴が見つかりません。");
        const currentVersion = record.scheduleOverride?.version ?? 0;
        if (input.expectedVersion !== currentVersion) throw operationError(409, "別の操作で予約枠が変更されています。最新の予約表を読み込んでから移動してください。");
        // A stopped legacy row is a valid historical placement. This never enables its booking受付.
        const staff = input.staffId ? await tx.staff.findFirst({ where: { ...scope, id: input.staffId }, select: { id: true, name: true } }) : null;
        if (input.staffId && !staff) throw operationError(404, "この店舗の担当者が見つかりません。");
        const previous = record.scheduleOverride ?? record;
        const moved = moveHistoricalSchedule(previous, input);
        const version = currentVersion + 1;
        if (record.scheduleOverride) {
          const updated = await tx.historicalReservationScheduleOverride.updateMany({
            where: { ...scope, historicalReservationId: id, version: currentVersion },
            data: { ...moved, version, updatedByUserId: context.user.id }
          });
          if (updated.count !== 1) throw operationError(409, "予約枠が変更されています。最新の予約表を読み込んでください。");
        } else {
          await tx.historicalReservationScheduleOverride.create({ data: {
            ...scope, historicalReservationId: id, ...moved, version, updatedByUserId: context.user.id
          } });
        }
        await operationAudit(tx, context, request, { action: "reservation.history.schedule.move", resource: "historicalReservation", resourceId: id,
          metadata: { previous: { startsAt: previous.startsAt.toISOString(), endsAt: previous.endsAt?.toISOString() ?? null, staffId: previous.staffId },
            current: { startsAt: moved.startsAt.toISOString(), endsAt: moved.endsAt?.toISOString() ?? null, staffId: moved.staffId }, scheduleVersion: version } });
        return scheduleResponse(id, moved, staff?.name ?? null, version);
      });
      return reply.header("Cache-Control", "private, no-store").send(result);
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ code: "INVALID_HISTORY_SCHEDULE", message: "移動先の日時・担当者を確認してください。" });
      if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && [400, 403, 404, 409].includes(error.statusCode)) return reply.code(error.statusCode).send({ code: "HISTORY_SCHEDULE_REJECTED", message: error.message });
      // Two first moves can contend on the initial unique override even after the
      // policy row locks. Treat only that placement identity collision as stale.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" &&
        (error.meta?.modelName === "HistoricalReservationScheduleOverride" ||
          Array.isArray(error.meta?.target) && error.meta.target.includes("historicalReservationId"))) {
        return reply.code(409).send({ code: "HISTORY_SCHEDULE_REJECTED", message: "別の操作で予約枠が変更されています。最新の予約表を読み込んでから移動してください。" });
      }
      request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError", errorCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined }, "historical schedule move failed");
      return reply.code(500).send({ code: "HISTORY_SCHEDULE_FAILED", message: "予約枠を移動できませんでした。予約表を読み直して確認してください。" });
    }
  });
}
