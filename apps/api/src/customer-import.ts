import { createHash } from "node:crypto";
import { z } from "zod";

export const CUSTOMER_IMPORT_CHUNK_SIZE = 50;
export const CUSTOMER_IMPORT_BODY_LIMIT = 10 * 1024 * 1024;
export const SALONBOARD_SOURCE_STORE = "H000551123";
export const SALONBOARD_TARGET_TENANT = "missmrs-takamatsu";
const text = (maximum: number, minimum = 0) => z.string().trim().min(minimum).max(maximum).refine((value) => !value.includes("\0"), "取込データに使用できない文字があります。");
const optionalText = (maximum: number) => text(maximum).nullable().optional();
const rawText = (maximum: number, minimum = 0) => z.string().min(minimum).max(maximum).refine((value) => !value.includes("\0"), "取込データに使用できない文字があります。");
const profileSchema = z.record(rawText(120, 1), rawText(4000)).superRefine((profile, context) => {
  if (Object.keys(profile).length > 100 || Buffer.byteLength(JSON.stringify(profile), "utf8") > 24000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "顧客プロフィールの項目数・サイズを確認してください。" });
  }
});

function calendarDate(value: string | null | undefined): string | null {
  if (!value || ["-", "—", "未登録", "なし"].includes(value)) return null;
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s*[(（][^\r\n]{1,10}[)）])?$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized ? normalized : null;
}

export const salonboardCustomerRecordSchema = z.object({
  externalCustomerId: text(160, 1).refine((value) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value), "取込データの顧客IDを確認してください。"),
  name: text(100, 1),
  kana: text(100),
  customerNumber: optionalText(160),
  gender: optionalText(100),
  occupation: optionalText(200),
  sourceVisitCount: z.number().int().min(0).max(1_000_000).nullable().optional(),
  sourceLastVisitDate: optionalText(50),
  phone: optionalText(30),
  email: optionalText(320),
  birthDate: optionalText(50),
  address: optionalText(1000),
  profile: profileSchema.optional()
}).strict().superRefine((record, context) => {
  const phone = record.phone?.trim() || labelValue(record.profile ?? {}, labelGroups.phone) || labelValue(record.profile ?? {}, labelGroups.phone2);
  if (phone && phone.length > 30) context.addIssue({ code: z.ZodIssueCode.custom, message: "電話番号は30文字以内にしてください。", path: ["phone"] });
});
export type SalonboardCustomerRecord = z.infer<typeof salonboardCustomerRecordSchema>;
export const salonboardImportEnvelopeSchema = z.object({
  version: z.literal(1), source: z.literal("SALONBOARD", { errorMap: () => ({ message: "取込ファイルの形式を確認してください。" }) }), sourceStoreId: z.literal(SALONBOARD_SOURCE_STORE),
  expectedCount: z.number().int().min(1).max(10000), capturedAt: z.string().datetime({ offset: true }),
  records: z.array(salonboardCustomerRecordSchema).min(1).max(10000)
}).strict().superRefine((input, context) => {
  if (input.expectedCount !== input.records.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "ファイルの総件数と取込件数が一致しません。", path: ["expectedCount"] });
  if (new Set(input.records.map((record) => record.externalCustomerId)).size !== input.records.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "取込データの顧客IDが重複しています。", path: ["records"] });
  }
});
export type SalonboardImportEnvelope = z.infer<typeof salonboardImportEnvelopeSchema>;
export const salonboardImportChunkSchema = z.object({
  offset: z.number().int().min(0).max(9999).refine((value) => value % CUSTOMER_IMPORT_CHUNK_SIZE === 0, "取込位置を確認してください。"),
  records: z.array(salonboardCustomerRecordSchema).min(1).max(CUSTOMER_IMPORT_CHUNK_SIZE)
}).strict();

/** Sorted recursive keys make the manifest independent of JSON object key ordering. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function importChecksum(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export function prepareSalonboardManifest(value: unknown) {
  const envelope = salonboardImportEnvelopeSchema.parse(value);
  return { envelope, checksum: importChecksum(envelope), recordHashes: envelope.records.map(importChecksum) };
}

function normalizedLabel(value: string) { return value.normalize("NFKC").replace(/[\s:：()（）]/g, "").toLowerCase(); }
const labelGroups = {
  phone: ["電話番号1", "電話番号", "携帯電話番号", "電話1", "phone"],
  phone2: ["電話番号2", "電話2"],
  email: ["メールアドレスPC", "PCメールアドレス", "メールPC", "メールアドレス", "email", "E-MAIL (PC)"],
  mobileEmail: ["メールアドレス携帯", "携帯メールアドレス", "メール携帯", "モバイルメール", "E-MAIL (携帯)"],
  birthDate: ["生年月日", "誕生日", "birthdate"],
  address: ["住所", "現住所", "address"],
  postalCode: ["郵便番号", "postalcode"]
};
function labelValue(profile: Record<string, string>, labels: string[]): string | null {
  const normalized = new Map(Object.entries(profile).map(([label, value]) => [normalizedLabel(label), value.trim()]));
  for (const label of labels) { const value = normalized.get(normalizedLabel(label)); if (value && !["-", "—", "未登録"].includes(value)) return value; }
  return null;
}
export function salonboardRecordProfile(record: SalonboardCustomerRecord, capturedAt: string) {
  const labels = record.profile ?? {};
  const phone1 = record.phone?.trim() || labelValue(labels, labelGroups.phone);
  const phone2 = labelValue(labels, labelGroups.phone2);
  return {
    version: 1, capturedAt,
    customerNumber: record.customerNumber ?? null, gender: record.gender ?? null, occupation: record.occupation ?? null,
    sourceVisitCount: record.sourceVisitCount ?? null, sourceLastVisitDate: calendarDate(record.sourceLastVisitDate),
    sourceLastVisitDateRaw: record.sourceLastVisitDate ?? null,
    phone: phone1 || phone2 || null, phone2,
    email: record.email?.trim() || labelValue(labels, labelGroups.email), mobileEmail: labelValue(labels, labelGroups.mobileEmail),
    birthDate: calendarDate(record.birthDate || labelValue(labels, labelGroups.birthDate)),
    birthDateRaw: record.birthDate || labelValue(labels, labelGroups.birthDate),
    address: record.address?.trim() || labelValue(labels, labelGroups.address), postalCode: labelValue(labels, labelGroups.postalCode),
    labels
  };
}

/** Project source metrics separately; do not turn them into local visits or sales. */
export function customerExternalDetail(record: {
  source: string; sourceStoreId: string; externalCustomerId: string; importedAt: Date;
  profile: unknown;
}, canReadChart: boolean) {
  const profile = record.profile && typeof record.profile === "object" && !Array.isArray(record.profile)
    ? record.profile as Record<string, unknown> : {};
  const safeText = (key: string) => typeof profile[key] === "string" ? profile[key] as string : null;
  return {
    source: record.source, sourceStoreId: record.sourceStoreId, externalCustomerId: record.externalCustomerId,
    importedAt: record.importedAt.toISOString(), capturedAt: safeText("capturedAt"),
    customerNumber: safeText("customerNumber"), gender: safeText("gender"), occupation: safeText("occupation"),
    sourceVisitCount: Number.isInteger(profile.sourceVisitCount) && Number(profile.sourceVisitCount) >= 0 ? Number(profile.sourceVisitCount) : null,
    sourceLastVisitDate: safeText("sourceLastVisitDate"), sourceLastVisitDateRaw: safeText("sourceLastVisitDateRaw"), phone: safeText("phone"), phone2: safeText("phone2"),
    email: safeText("email"), mobileEmail: safeText("mobileEmail"), birthDate: safeText("birthDate"),
    address: safeText("address"), postalCode: safeText("postalCode"),
    ...(canReadChart ? { profile: profile.labels && typeof profile.labels === "object" && !Array.isArray(profile.labels) ? profile.labels : {} } : {})
  };
}
