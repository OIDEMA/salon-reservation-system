import sharp from "sharp";
import { z } from "zod";

export const MAX_CHART_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_CHART_PHOTOS = 10;
export const MAX_CHART_PHOTO_PIXELS = 24_000_000;

export class ChartError extends Error {
  constructor(public code: string, message: string, public statusCode = 400, public chartId?: string) {
    super(message);
  }
}

const text = (maximum: number) => z.string().max(maximum, `${maximum}文字以内で入力してください。`).default("");
export const chartFieldsSchema = z.object({
  treatmentAt: z.string().datetime({ offset: true, message: "施術日時を入力してください。" })
    .refine((value) => Number.isFinite(Date.parse(value)), "施術日時を確認してください。"),
  bodyParts: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  performedServiceDetail: text(8000),
  machine: text(200),
  outputJ: text(200),
  pulseWidth: text(200),
  skinObservations: text(4000),
  productsMaterials: text(4000),
  aftercareNotes: text(4000),
  nextVisitPlan: text(4000)
}).strict();

export const chartExpectedVersionSchema = z.number().int().min(1).max(2_000_000_000);
export const chartCreateSchema = chartFieldsSchema.extend({ reservationId: z.string().min(1).max(160) }).strict();
export const chartUpdateSchema = chartFieldsSchema.extend({ expectedVersion: chartExpectedVersionSchema }).strict();
export const chartVersionSchema = z.object({ expectedVersion: chartExpectedVersionSchema }).strict();
export const chartAmendSchema = chartVersionSchema.extend({
  reason: z.string().trim().min(1, "訂正理由を入力してください。").max(1000, "訂正理由は1000文字以内で入力してください。")
}).strict();
export type ChartFields = z.infer<typeof chartFieldsSchema>;

export function chartFieldData(fields: ChartFields) {
  return { ...fields, treatmentAt: new Date(fields.treatmentAt), bodyParts: [...new Set(fields.bodyParts)] };
}

export function assertChartVersion(version: number, expectedVersion: number) {
  if (version !== expectedVersion) {
    throw new ChartError("CHART_CONFLICT", "別の操作でカルテが更新されました。入力内容を控えて、最新のカルテを読み直してください。", 409);
  }
}

export function assertChartDraft(status: string) {
  if (status !== "DRAFT") {
    throw new ChartError("CHART_FINALIZED", "確定済みのカルテは変更できません。訂正理由を入力して新しい版を作成してください。", 409);
  }
}

export function assertChartFinalizable(fields: Pick<ChartFields, "performedServiceDetail">) {
  if (!fields.performedServiceDetail.trim()) {
    throw new ChartError("CHART_CONTENT_REQUIRED", "確定する前に施術内容を入力してください。");
  }
}

function hasAnimationControl(input: Buffer, format: "jpeg" | "png" | "webp") {
  // Some decoders expose only the first APNG frame without a metadata.pages value.
  // Walk actual container chunks, rather than searching arbitrary compressed bytes.
  if (format === "png" && input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let offset = 8; offset + 12 <= input.length;) {
      const length = input.readUInt32BE(offset);
      if (length > input.length - offset - 12) break;
      if (input.toString("ascii", offset + 4, offset + 8) === "acTL") return true;
      offset += length + 12;
    }
  }
  if (format === "webp" && input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP") {
    const end = Math.min(input.length, input.readUInt32LE(4) + 8);
    for (let offset = 12; offset + 8 <= end;) {
      const length = input.readUInt32LE(offset + 4);
      if (length > end - offset - 8) break;
      if (["ANIM", "ANMF"].includes(input.toString("ascii", offset, offset + 4))) return true;
      offset += length + 8 + (length % 2);
    }
  }
  return false;
}

export async function normalizeChartPhoto(input: Buffer, contentType: string) {
  if (input.length === 0 || input.length > MAX_CHART_PHOTO_BYTES) {
    throw new ChartError("CHART_PHOTO_SIZE", "写真は1枚5MB以内にしてください。", 413);
  }
  const mimeType = contentType.split(";", 1)[0].trim().toLowerCase();
  const formatByType: Record<string, "jpeg" | "png" | "webp"> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };
  const expectedFormat = formatByType[mimeType];
  if (!expectedFormat) throw new ChartError("CHART_PHOTO_TYPE", "JPEG・PNG・WebPの写真を選択してください。", 415);

  try {
    const options = { failOn: "warning" as const, limitInputPixels: MAX_CHART_PHOTO_PIXELS };
    const metadata = await sharp(input, options).metadata();
    if (metadata.format !== expectedFormat || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || hasAnimationControl(input, expectedFormat) ||
      metadata.width > 16384 || metadata.height > 16384 || metadata.width * metadata.height > MAX_CHART_PHOTO_PIXELS) {
      throw new ChartError("CHART_PHOTO_INVALID", "写真の形式・サイズを確認してください。アニメーション画像は保存できません。");
    }
    // Decode every pixel, apply the camera orientation, and omit EXIF/GPS metadata.
    // Re-encoding also prevents arbitrary trailing data from being served as an image.
    let image = sharp(input, options).rotate();
    if (expectedFormat === "jpeg") image = image.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
    else if (expectedFormat === "png") image = image.png({ compressionLevel: 9 });
    else image = image.webp({ lossless: true });
    const result = await image.toBuffer({ resolveWithObject: true });
    if (result.data.length > MAX_CHART_PHOTO_BYTES) {
      throw new ChartError("CHART_PHOTO_SIZE", "保存用の写真が5MBを超えます。画像のサイズを小さくして選択し直してください。", 413);
    }
    return { data: result.data, mimeType, width: result.info.width, height: result.info.height, byteSize: result.data.length };
  } catch (error) {
    if (error instanceof ChartError) throw error;
    throw new ChartError("CHART_PHOTO_INVALID", "写真を読み取れません。JPEG・PNG・WebPの画像を選択し直してください。");
  }
}
