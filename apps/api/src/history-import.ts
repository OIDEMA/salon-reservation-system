import { z } from "zod";
import type { ReservationStatus } from "@prisma/client";
import { importChecksum, SALONBOARD_SOURCE_STORE, SALONBOARD_TARGET_TENANT } from "./customer-import.js";

export { SALONBOARD_SOURCE_STORE, SALONBOARD_TARGET_TENANT };
export const HISTORY_IMPORT_CHUNK_SIZE = 50;
export const HISTORY_IMPORT_BODY_LIMIT = 20 * 1024 * 1024;
export const HISTORY_IMPORT_RAW_ROW_LIMIT = 64 * 1024;
const text = (max: number, min = 0) => z.string().trim().min(min).max(max).refine((value) => !value.includes("\0"), "使用できない文字が含まれています。");
const nullableText = (max: number) => text(max).nullable();
const identifier = text(160, 1).refine((value) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value), "取込データのIDを確認してください。");
const rawText = (max: number) => z.string().max(max).refine((value) => !value.includes("\0"), "使用できない文字が含まれています。");
export const historyDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "有効な日付を指定してください。");
const timestamp = z.string().datetime({ offset: true }).refine((value) => Number.isFinite(new Date(value).getTime()), "時刻にはタイムゾーンを含めてください。");

export function historyJstDate(value: string | Date) { return new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().split("T")[0]; }
export function historyJstMidnight(value: string) { return new Date(`${value}T00:00:00+09:00`); }
export function nextHistoryDate(value: string) { return new Date(new Date(`${value}T00:00:00Z`).getTime() + 86400000).toISOString().split("T")[0]; }

export const historyReservationRecordSchema = z.object({
  externalReservationId: identifier,
  externalCustomerId: identifier.nullable(), customerNumber: nullableText(160), externalStaffId: identifier.nullable(),
  customerName: text(200, 1), customerKana: nullableText(200), staffName: nullableText(200), sourceStatus: text(100, 1),
  startsAt: timestamp, endsAt: timestamp.nullable(), durationMinutes: z.number().int().min(1).max(10080).nullable(),
  menuText: nullableText(8000), reservationAmount: z.number().int().min(0).max(2_147_483_647).nullable(),
  sourceRoute: nullableText(200), nominated: z.boolean().nullable(), equipmentName: nullableText(500),
  rawHeaders: z.array(rawText(500)).min(1).max(200), rawValues: z.array(rawText(HISTORY_IMPORT_RAW_ROW_LIMIT)).min(1).max(200)
}).strict().superRefine((record, context) => {
  if (record.rawHeaders.length !== record.rawValues.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "取込データの列数が一致しません。", path: ["rawValues"] });
  if (Buffer.byteLength(JSON.stringify([record.rawHeaders, record.rawValues]), "utf8") > HISTORY_IMPORT_RAW_ROW_LIMIT) context.addIssue({ code: z.ZodIssueCode.custom, message: "取込データの1行は64KiB以内にしてください。", path: ["rawValues"] });
  if (record.endsAt && new Date(record.endsAt) <= new Date(record.startsAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "終了日時は開始日時より後にしてください。", path: ["endsAt"] });
});
export type HistoryReservationRecord = z.infer<typeof historyReservationRecordSchema>;
export const historyImportEnvelopeSchema = z.object({
  version: z.literal(1), source: z.literal("SALONBOARD", { error: "取込ファイルの形式を確認してください。" }), sourceStoreId: z.literal(SALONBOARD_SOURCE_STORE),
  periodFrom: historyDateSchema, periodTo: historyDateSchema, capturedAt: timestamp,
  expectedCount: z.number().int().min(1).max(10000), records: z.array(historyReservationRecordSchema).min(1).max(10000)
}).strict().superRefine((envelope, context) => {
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > HISTORY_IMPORT_BODY_LIMIT) context.addIssue({ code: z.ZodIssueCode.custom, message: "取込ファイルは20MiB以内にしてください。" });
  if (envelope.periodFrom >= envelope.periodTo) context.addIssue({ code: z.ZodIssueCode.custom, message: "対象期間の終了日は開始日より後にしてください。", path: ["periodTo"] });
  if (envelope.expectedCount !== envelope.records.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "ファイルの総件数と取込件数が一致しません。", path: ["expectedCount"] });
  if (new Set(envelope.records.map((record) => record.externalReservationId)).size !== envelope.records.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "取込データの予約IDが重複しています。", path: ["records"] });
  for (const [index, record] of envelope.records.entries()) {
    if (!Number.isFinite(new Date(record.startsAt).getTime())) continue;
    const day = historyJstDate(record.startsAt);
    if (day < envelope.periodFrom || day >= envelope.periodTo) context.addIssue({ code: z.ZodIssueCode.custom, message: "予約日時が対象期間（日本時間）に含まれていません。", path: ["records", index, "startsAt"] });
  }
});
export const historyImportChunkSchema = z.object({
  offset: z.number().int().min(0).max(9999).refine((value) => value % HISTORY_IMPORT_CHUNK_SIZE === 0, "取込位置を確認してください。"),
  records: z.array(historyReservationRecordSchema).min(1).max(HISTORY_IMPORT_CHUNK_SIZE)
}).strict();

export function prepareHistoryManifest(value: unknown) {
  const envelope = historyImportEnvelopeSchema.parse(value);
  const monthCounts: Record<string, number> = Object.create(null);
  const statusCounts: Record<string, number> = Object.create(null);
  for (const record of envelope.records) {
    const month = historyJstDate(record.startsAt).slice(0, 7);
    monthCounts[month] = (monthCounts[month] ?? 0) + 1;
    statusCounts[record.sourceStatus] = (statusCounts[record.sourceStatus] ?? 0) + 1;
  }
  return { envelope, checksum: importChecksum(envelope), recordHashes: envelope.records.map(importChecksum), monthCounts, statusCounts };
}

/** Exact known labels only; original status is retained for every source row. */
export function normalizedHistoryStatus(status: string): ReservationStatus | null {
  const labels: Readonly<Record<string, ReservationStatus>> = {
    "未確定": "PENDING", "仮予約": "PENDING", "未確認": "PENDING",
    "予約": "CONFIRMED", "予約確定": "CONFIRMED", "確定": "CONFIRMED",
    "来店": "ARRIVED", "受付済み": "ARRIVED",
    "来店済み": "COMPLETED", "施術済み": "COMPLETED", "完了": "COMPLETED",
    "キャンセル": "CANCELLED", "取消": "CANCELLED", "キャンセル済み": "CANCELLED",
    "無断キャンセル": "NO_SHOW", "キャンセル待ち": "WAITLIST"
  };
  return Object.hasOwn(labels, status) ? labels[status] : null;
}

export const historyPageQuerySchema = z.object({
  q: text(100).optional().default(""), from: historyDateSchema.optional(), to: historyDateSchema.optional(),
  sourceStatus: text(100, 1).optional(), page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
}).strict().superRefine((query, context) => {
  if (query.from && query.to && query.from > query.to) context.addIssue({ code: z.ZodIssueCode.custom, message: "期間の開始日は終了日以前にしてください。", path: ["to"] });
});
export type HistoryPageQuery = z.infer<typeof historyPageQuerySchema>;
