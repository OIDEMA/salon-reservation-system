import { createHash } from "node:crypto";
import { Prisma, type StaffRole } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { importChecksum } from "./customer-import.js";
import { historyJstMidnight } from "./history-import.js";
import { staffPublicationKey } from "./staff-import.js";
import { hasPermission } from "./permissions.js";
import { lockOperation, operationAudit, operationError, requireOperationContext, runSerializable, type OperationContext } from "./operations-support.js";

const source = "SALONBOARD";
const sourceStoreId = "H000551123";
export const HISTORY_STAFF_PERIOD_FROM = "2025-10-14";
export const HISTORY_STAFF_PERIOD_TO = "2026-10-14";
const root = "/api/admin/history-staff-links";
const maxRecords = 10000;

export function historyStaffSnapshotKey(storeId: string, staffName: string): string {
  return createHash("sha256").update(JSON.stringify([storeId, "STAFF_HISTORY_LABEL_SNAPSHOT", staffName])).digest("hex");
}

type SourceRecord = { id: string; externalReservationId: string; externalStaffId: string | null; staffName: string | null; staffId: string | null };
type StaffTarget = { id: string; name: string; role: StaffRole; active: boolean };
type SourceMapping = { externalRecordKey: string; staff: StaffTarget };
export type HistoryStaffLinkGroup = {
  key: string; sourceStaffName: string; count: number; staffId: string | null; staffName: string | null;
  role: StaffRole; action: "LINK_EXISTING" | "CREATE_INACTIVE"; active: boolean; alreadyLinkedCount: number;
};
export type HistoryStaffLinkPlan = {
  checksum: string; periodFrom: string; periodTo: string; totalCount: number; linkedCount: number; pendingCount: number;
  existingStaffCount: number; newStaffCount: number; groups: HistoryStaffLinkGroup[]; ready: boolean; issues: string[];
};

function historicalRole(name: string): StaffRole {
  return ["既存身体", "新規全身"].includes(name.replace(/[\s\u3000]/g, "")) ? "ROOM_RESOURCE" : "ESTHETICIAN";
}

/** Exact source identity only. Legacy labels never merge into a similarly named local master. */
export function buildHistoryStaffLinkPlan(records: SourceRecord[], mappings: SourceMapping[], allStaff: StaffTarget[]): HistoryStaffLinkPlan {
  const issues: string[] = [];
  const byKey = new Map(mappings.map((mapping) => [mapping.externalRecordKey, mapping.staff]));
  const grouped = new Map<string, { records: SourceRecord[]; target?: StaffTarget; publication: boolean }>();
  for (const record of records) {
    if (!record.staffName || !record.staffName.trim()) { issues.push("担当名のない履歴があります。元情報を確認してください。"); continue; }
    const key = record.externalStaffId ? staffPublicationKey(sourceStoreId, record.externalStaffId) : historyStaffSnapshotKey(sourceStoreId, record.staffName);
    const group = grouped.get(key) ?? { records: [], target: byKey.get(key), publication: Boolean(record.externalStaffId) };
    group.records.push(record); grouped.set(key, group);
  }
  const groups: HistoryStaffLinkGroup[] = [];
  for (const [key, group] of grouped) {
    const names = new Set(group.records.map((record) => record.staffName));
    const sourceStaffName = group.records[0].staffName!;
    if (names.size !== 1) issues.push("同じ担当の識別値に複数の名前があります。元情報を確認してください。");
    if (group.publication && !group.target) issues.push("移行済み担当の参照先が見つかりません。スタッフの移行結果を確認してください。");
    if (!group.publication && !group.target && allStaff.some((staff) => staff.name.normalize("NFKC").replace(/\s/g, "") === sourceStaffName.normalize("NFKC").replace(/\s/g, ""))) {
      issues.push("過去担当と同名の登録済みスタッフがあります。担当の対応を確認してください。");
    }
    if (group.records.some((record) => record.staffId && record.staffId !== group.target?.id)) issues.push("元情報と異なる担当に紐付いた履歴があります。担当の対応を確認してください。");
    groups.push({ key, sourceStaffName, count: group.records.length, staffId: group.target?.id ?? null,
      staffName: group.target?.name ?? null, role: group.target?.role ?? historicalRole(sourceStaffName),
      action: group.target ? "LINK_EXISTING" : "CREATE_INACTIVE", active: group.target?.active ?? false,
      alreadyLinkedCount: group.records.filter((record) => group.target && record.staffId === group.target.id).length });
  }
  groups.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const stableRecords = records.map(({ id, externalReservationId, externalStaffId, staffName }) => ({ id, externalReservationId, externalStaffId, staffName })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const checksum = importChecksum({ version: 1, source, sourceStoreId, periodFrom: HISTORY_STAFF_PERIOD_FROM, periodTo: HISTORY_STAFF_PERIOD_TO,
    records: stableRecords, targets: groups.map((group) => ({ key: group.key, publicationStaffId: grouped.get(group.key)!.publication ? group.staffId : null })) });
  const linkedCount = groups.reduce((sum, group) => sum + group.alreadyLinkedCount, 0);
  if (!records.length) issues.push("対象期間の予約履歴がありません。");
  if (records.length > maxRecords) issues.push("対象件数が上限を超えています。");
  return { checksum, periodFrom: HISTORY_STAFF_PERIOD_FROM, periodTo: HISTORY_STAFF_PERIOD_TO,
    totalCount: records.length, linkedCount, pendingCount: records.length - linkedCount,
    existingStaffCount: groups.filter((group) => group.action === "LINK_EXISTING").length,
    newStaffCount: groups.filter((group) => group.action === "CREATE_INACTIVE").length,
    groups, ready: issues.length === 0, issues: [...new Set(issues)] };
}

function scope(context: OperationContext) { return { tenantId: context.tenant.id, salonId: context.salon.id }; }
function historyScope(context: OperationContext) {
  return { ...scope(context), source, sourceStoreId, startsAt: { gte: historyJstMidnight(HISTORY_STAFF_PERIOD_FROM), lt: historyJstMidnight(HISTORY_STAFF_PERIOD_TO) } };
}
function assertAuthority(context: OperationContext) {
  if (context.tenant.slug !== "missmrs-takamatsu") throw operationError(403, "この反映はミスミセス高松店だけで実行できます。");
  if (!hasPermission(context, "master.write") || !hasPermission(context, "chart.write")) throw operationError(403, "スタッフと予約履歴を反映する権限がありません。");
}
async function readPlan(tx: Prisma.TransactionClient, context: OperationContext) {
  const [records, mappings, allStaff] = await Promise.all([
    tx.historicalReservation.findMany({ where: historyScope(context), select: { id: true, externalReservationId: true, externalStaffId: true, staffName: true, staffId: true }, take: maxRecords + 1, orderBy: { id: "asc" } }),
    tx.staffExternalRecord.findMany({ where: { ...scope(context), source, sourceStoreId }, select: { externalRecordKey: true, staff: { select: { id: true, name: true, role: true, active: true } } } }),
    tx.staff.findMany({ where: scope(context), select: { id: true, name: true, role: true, active: true } })
  ]);
  return { records, plan: buildHistoryStaffLinkPlan(records, mappings, allStaff) };
}
function safeRoute(handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try { return await handler(request, reply); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ message: "反映内容を確認してください。" });
      if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && [400, 403, 404, 409].includes(error.statusCode)) return reply.code(error.statusCode).send({ message: error.message });
      request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "history staff link failed");
      return reply.code(500).send({ message: "反映できませんでした。担当の対応を再確認して再実行してください。" });
    }
  };
}

export async function registerHistoryStaffLinkRoutes(server: FastifyInstance, options: { requireContext?: typeof requireOperationContext } = {}) {
  const requireContext = options.requireContext ?? requireOperationContext;
  server.post(root + "/prepare", { bodyLimit: 1024 }, safeRoute(async (request, reply) => {
    const context = await requireContext(request, reply, "reservation.write");
    if (!context) return;
    assertAuthority(context); z.object({}).strict().parse(request.body ?? {});
    const { plan } = await prisma.$transaction((tx) => readPlan(tx, context), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
    return reply.header("Cache-Control", "private, no-store").send(plan);
  }));
  server.post(root + "/apply", { bodyLimit: 1024 }, safeRoute(async (request, reply) => {
    const context = await requireContext(request, reply, "reservation.write");
    if (!context) return;
    assertAuthority(context);
    const input = z.object({ checksum: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(request.body);
    const result = await runSerializable(async (tx) => {
      await lockOperation(tx, context, "reservation.write"); assertAuthority(context);
      const { plan, records } = await readPlan(tx, context);
      if (input.checksum !== plan.checksum) throw operationError(409, "元情報または担当の対応が変更されています。反映内容を再確認してください。");
      if (!plan.ready) throw operationError(409, plan.issues.join(" "));
      const maximumOrder = await tx.staff.aggregate({ where: scope(context), _max: { sortOrder: true, allocationOrder: true } });
      let createdStaffCount = 0;
      for (const group of plan.groups) {
        let staffId = group.staffId;
        if (!staffId) {
          const staff = await tx.staff.create({ data: { ...scope(context), name: group.sourceStaffName, kana: "", role: group.role,
            color: "#64748b", active: false, nominationFee: 0, parallelCapacity: 1,
            sortOrder: (maximumOrder._max.sortOrder ?? 0) + createdStaffCount + 1,
            allocationOrder: (maximumOrder._max.allocationOrder ?? 0) + createdStaffCount + 1,
            comment: "サロンボードの過去予約から移行した担当（予約受付停止）。元情報は担当名の記録です。" } });
          staffId = staff.id; createdStaffCount++;
          await tx.staffExternalRecord.create({ data: { ...scope(context), staffId, source, sourceStoreId, externalRecordKey: group.key,
            profile: { identityKind: "SOURCE_HISTORY_STAFF_LABEL_SNAPSHOT", sourceStaffName: group.sourceStaffName, periodFrom: HISTORY_STAFF_PERIOD_FROM, periodTo: HISTORY_STAFF_PERIOD_TO, historyOnly: true, importedActive: false } } });
        }
        const ids = records.filter((record) => record.externalStaffId ? staffPublicationKey(sourceStoreId, record.externalStaffId) === group.key : record.staffName && historyStaffSnapshotKey(sourceStoreId, record.staffName) === group.key).map((record) => record.id);
        await tx.historicalReservation.updateMany({ where: { ...historyScope(context), id: { in: ids }, staffId: null }, data: { staffId } });
      }
      const linkedCount = await tx.historicalReservation.count({ where: { ...historyScope(context), staffId: { not: null } } });
      if (linkedCount !== plan.totalCount) throw operationError(409, "一部の担当を反映できませんでした。元情報を確認してください。");
      if (createdStaffCount || plan.pendingCount) await operationAudit(tx, context, request, { action: "reservation.history.staff-link", resource: "historicalReservation",
        metadata: { checksum: plan.checksum, totalCount: plan.totalCount, linkedCount, createdStaffCount, previouslyLinkedCount: plan.linkedCount } });
      return { totalCount: plan.totalCount, linkedCount, pendingCount: 0, createdStaffCount, alreadyLinkedCount: plan.linkedCount, completed: true };
    });
    return reply.header("Cache-Control", "private, no-store").send(result);
  }));
}
