import { createHash } from "node:crypto";
import { z } from "zod";
import { importChecksum } from "./customer-import.js";

export const STAFF_IMPORT_SOURCE_STORE = "H000551123";
export const STAFF_IMPORT_TARGET_TENANT = "missmrs-takamatsu";
export const STAFF_IMPORT_BODY_LIMIT = 5 * 1024 * 1024;
const text = (max: number, min = 0) => z.string().trim().min(min).max(max).refine((value) => !value.includes("\0"), "使用できない文字があります。");
type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.string().max(10000).refine((value) => !value.includes("\0")), z.number().finite(), z.boolean(),
  z.array(jsonValue).max(500), z.record(z.string().max(120).refine((value) => !value.includes("\0")), jsonValue)
]));
const profile = z.record(z.string().min(1).max(120).refine((value) => !value.includes("\0")), jsonValue).refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 24000, "スタッフの元情報が大きすぎます。");

/** A snapshot natural key, not an immutable ID supplied by SalonBoard. */
export function staffNaturalKey(sourceStoreId: string, name: string, kana: string): string {
  return createHash("sha256").update(JSON.stringify([sourceStoreId, name.normalize("NFKC").trim(), kana.normalize("NFKC").trim()])).digest("hex");
}
export function staffPublicationKey(sourceStoreId: string, publicationStaffId: string): string {
  return createHash("sha256").update(JSON.stringify([sourceStoreId, "STAFF_PUBLICATION", publicationStaffId])).digest("hex");
}
export const staffImportRecordSchema = z.object({
  externalRecordKey: z.string().regex(/^[0-9a-f]{64}$/), name: text(100, 1), kana: text(100),
  publicationStaffId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).optional(),
  role: z.enum(["ESTHETICIAN", "ROOM_RESOURCE"]), parallelCapacity: z.number().int().min(1).max(20),
  allocationOrder: z.number().int().min(1).max(1000000), sortOrder: z.number().int().min(0).max(1000000),
  active: z.boolean(), nominationFee: z.number().int().min(0).max(10000000).optional(), comment: z.string().max(1000).refine((value) => !value.includes("\0")).nullable().optional(), profile
}).strict().superRefine((record, context) => {
  const expectedKey = record.publicationStaffId ? staffPublicationKey(STAFF_IMPORT_SOURCE_STORE, record.publicationStaffId) : staffNaturalKey(STAFF_IMPORT_SOURCE_STORE, record.name, record.kana);
  if (record.externalRecordKey !== expectedKey) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "スタッフの元情報と移行データの識別値が一致しません。", path: ["externalRecordKey"] });
  }
  if (record.role === "ROOM_RESOURCE" && record.active) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "管理枠は無効な設備枠として取り込んでください。", path: ["active"] });
  }
});
export const staffImportEnvelopeSchema = z.object({
  version: z.literal(1), source: z.literal("SALONBOARD"), sourceStoreId: z.literal(STAFF_IMPORT_SOURCE_STORE),
  capturedAt: z.string().datetime({ offset: true }), expectedCount: z.number().int().min(1).max(100),
  records: z.array(staffImportRecordSchema).min(1).max(100)
}).strict().superRefine((input, context) => {
  if (input.expectedCount !== input.records.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "移行元の総件数と登録件数が一致しません。", path: ["expectedCount"] });
  if (new Set(input.records.map((record) => record.externalRecordKey)).size !== input.records.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "同じ移行元のスタッフが複数含まれています。元情報を確認してください。", path: ["records"] });
  }
});
export type StaffImportEnvelope = z.infer<typeof staffImportEnvelopeSchema>;
export function prepareStaffImport(value: unknown) {
  const envelope = staffImportEnvelopeSchema.parse(value);
  return { envelope, checksum: importChecksum(envelope) };
}
