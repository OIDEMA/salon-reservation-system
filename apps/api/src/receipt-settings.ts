import { z } from "zod";

export const receiptIssuerNameSchema = z.string()
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/u, "正式事業者名に改行や制御文字は使用できません。")
  .trim().min(1, "領収書に記載する正式事業者名を入力してください。")
  .max(300, "正式事業者名は300文字以内で入力してください。");

export const invoiceRegistrationNumberSchema = z.string().trim().toUpperCase()
  .regex(/^T[0-9]{13}$/, "適格請求書発行事業者の登録番号は、半角のTと13桁の数字で入力してください。");

function emptyToNull(value: unknown) {
  return typeof value === "string" && value.trim() === "" ? null : value;
}

/** Optional keys preserve existing settings during PATCH; explicit blanks clear them. */
export const receiptSettingsInputSchema = z.object({
  receiptIssuerName: z.preprocess(emptyToNull, receiptIssuerNameSchema.nullable().optional()),
  invoiceRegistrationNumber: z.preprocess(emptyToNull, invoiceRegistrationNumberSchema.nullable().optional())
});
