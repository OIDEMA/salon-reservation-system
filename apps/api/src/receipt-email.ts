import type { CashCheckout, CashCheckoutItem, CashPaymentAllocation } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CASH_MAX_YEN, CashError, cashAssert, cashPaymentMethods } from "./cash-domain.js";
import { receiptIssuerNameSchema, invoiceRegistrationNumberSchema } from "./receipt-settings.js";

export const RECEIPT_EVENT = "checkout.receipt";
const controls = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const safeLine = (maximum: number) => z.string().refine((value) => !controls.test(value), "制御文字は使用できません。")
  .transform((value) => value.trim()).pipe(z.string().min(1).max(maximum));
export const receiptInputSchema = z.object({
  requestId: z.string().uuid(),
  previewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  version: z.number().int().positive(),
  recipientEmail: z.string().refine((value) => !controls.test(value), "制御文字は使用できません。")
    .transform((value) => value.trim()).pipe(z.string().email().max(254)),
  recipientName: safeLine(100),
  description: safeLine(200)
}).strict();
export type ReceiptInput = z.infer<typeof receiptInputSchema>;

const yen = z.number().int().min(0).max(CASH_MAX_YEN);
const taxRate = z.union([z.literal(0), z.literal(8), z.literal(10)]);
const receiptItemSchema = z.object({
  label: safeLine(160), quantity: z.number().int().min(1).max(999), unitPriceYen: yen,
  discountYen: yen, pointsDiscountYen: yen.optional(), taxRate, taxYen: yen, totalYen: yen
}).strict();
const taxBreakdownSchema = z.array(z.object({ taxRate, taxableTotalYen: yen, taxYen: yen }).strict()).min(1).max(3);
const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("ja-JP", { timeZone: value }).format(0); return true; } catch { return false; }
});

/** This allowlist is the entire persisted, customer-visible receipt. */
export const receiptSnapshotSchema = z.object({
  documentVersion: z.literal(1).optional(),
  issuerLegalName: receiptIssuerNameSchema.optional(), invoiceRegistrationNumber: invoiceRegistrationNumberSchema.optional(),
  receiptNumber: z.string().uuid(), issuerName: safeLine(300), paidAt: z.string().datetime(),
  treatmentAt: z.string().datetime(), timezone: timezoneSchema, recipientName: safeLine(100), description: safeLine(200),
  subtotalYen: yen, discountYen: yen, pointsDiscountYen: yen.optional(), taxYen: yen, totalYen: yen,
  items: z.array(receiptItemSchema).min(1).max(100), taxBreakdown: taxBreakdownSchema,
  payments: z.array(z.object({ method: z.enum(cashPaymentMethods), amountYen: yen.refine((amount) => amount > 0) }).strict()).max(20)
}).strict().superRefine((receipt, context) => {
  if (receipt.documentVersion === 1 && (!receipt.issuerLegalName || !receipt.invoiceRegistrationNumber)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "領収書の発行事業者名と登録番号が必要です。" });
  }
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const groupRates = new Set(receipt.taxBreakdown.map((group) => group.taxRate));
  // Already queued receipts predate points support. Missing fields mean zero and
  // remain missing after parsing so their captured payload and rendering stay intact.
  const consistent = receipt.items.every((item) => item.quantity * item.unitPriceYen - item.discountYen - (item.pointsDiscountYen ?? 0) === item.totalYen) &&
    sum(receipt.items.map((item) => item.quantity * item.unitPriceYen)) === receipt.subtotalYen &&
    sum(receipt.items.map((item) => item.discountYen)) === receipt.discountYen &&
    sum(receipt.items.map((item) => item.pointsDiscountYen ?? 0)) === (receipt.pointsDiscountYen ?? 0) &&
    sum(receipt.items.map((item) => item.totalYen)) === receipt.totalYen &&
    receipt.subtotalYen - receipt.discountYen - (receipt.pointsDiscountYen ?? 0) === receipt.totalYen &&
    sum(receipt.items.map((item) => item.taxYen)) === receipt.taxYen &&
    sum(receipt.payments.map((payment) => payment.amountYen)) === receipt.totalYen &&
    groupRates.size === receipt.taxBreakdown.length && receipt.items.every((item) => groupRates.has(item.taxRate)) &&
    receipt.taxBreakdown.every((group) => {
      const items = receipt.items.filter((item) => item.taxRate === group.taxRate);
      return items.length > 0 && sum(items.map((item) => item.totalYen)) === group.taxableTotalYen &&
        sum(items.map((item) => item.taxYen)) === group.taxYen &&
        Math.floor(group.taxableTotalYen * group.taxRate / (100 + group.taxRate)) === group.taxYen;
    });
  if (!consistent) context.addIssue({ code: z.ZodIssueCode.custom, message: "領収書の金額内訳が一致していません。" });
});
export type ReceiptSnapshot = z.infer<typeof receiptSnapshotSchema>;
export const RECEIPT_PDF_MAX_BYTES = 4 * 1024 * 1024;
export const receiptAttachmentSchema = z.object({
  fileName: z.string().regex(/^receipt-[0-9a-f-]{36}\.pdf$/),
  contentBase64: z.string().min(1).max(Math.ceil(RECEIPT_PDF_MAX_BYTES / 3) * 4),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict().superRefine((attachment, context) => {
  if (attachment.contentBase64.length > Math.ceil(RECEIPT_PDF_MAX_BYTES / 3) * 4) return;
  const bytes = Buffer.from(attachment.contentBase64, "base64");
  if (bytes.length < 8 || bytes.length > RECEIPT_PDF_MAX_BYTES || bytes.subarray(0, 5).toString() !== "%PDF-" ||
    bytes.toString("base64") !== attachment.contentBase64 || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "領収書PDFのデータを確認できません。" });
  }
});
export const receiptPayloadSchema = z.object({
  checkoutId: z.string().uuid(), requestId: z.string().uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: receiptSnapshotSchema, attachment: receiptAttachmentSchema.optional(),
  message: z.object({ subject: safeLine(160), text: z.string().min(1).max(10_000).refine((text) => !text.includes("\0")) }).strict().optional()
}).strict().superRefine((payload, context) => {
  if ((payload.receipt.documentVersion === 1) !== Boolean(payload.attachment) ||
    (payload.receipt.documentVersion === 1) !== Boolean(payload.message) ||
    payload.attachment && payload.attachment.fileName !== `receipt-${payload.checkoutId}.pdf`) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "領収書の添付ファイルが一致しません。" });
  }
});
export type ReceiptPayload = z.infer<typeof receiptPayloadSchema>;

type ReceiptCheckout = Pick<CashCheckout,
  "id" | "status" | "finalizedAt" | "reservationSnapshot" | "subtotalYen" | "discountYen" | "pointsDiscountYen" | "taxYen" | "totalYen" | "taxBreakdown"
> & {
  items: Pick<CashCheckoutItem, "lineNumber" | "label" | "quantity" | "unitPriceYen" | "discountYen" | "pointsDiscountYen" | "taxRate" | "taxYen" | "totalYen">[];
  payments: Pick<CashPaymentAllocation, "method" | "amountYen">[];
};

function cleanStoredLine(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").trim() : value;
}

export function createReceiptSnapshot(checkout: ReceiptCheckout, input: Pick<ReceiptInput, "recipientName" | "description">,
  issuer?: { receiptIssuerName: string; invoiceRegistrationNumber: string }): ReceiptSnapshot {
  cashAssert(checkout.status === "FINALIZED" && checkout.finalizedAt,
    "RECEIPT_UNAVAILABLE", "確定済みの会計から領収書を作成してください。", 409);
  const reservation = checkout.reservationSnapshot && typeof checkout.reservationSnapshot === "object" && !Array.isArray(checkout.reservationSnapshot)
    ? checkout.reservationSnapshot : {};
  const result = receiptSnapshotSchema.safeParse({
    ...(issuer ? { documentVersion: 1, issuerLegalName: issuer.receiptIssuerName, invoiceRegistrationNumber: issuer.invoiceRegistrationNumber } : {}),
    receiptNumber: checkout.id, issuerName: cleanStoredLine(reservation.salonName), paidAt: checkout.finalizedAt.toISOString(),
    treatmentAt: reservation.startsAt, timezone: reservation.timezone ?? "Asia/Tokyo",
    recipientName: input.recipientName, description: input.description,
    subtotalYen: checkout.subtotalYen, discountYen: checkout.discountYen, pointsDiscountYen: checkout.pointsDiscountYen, taxYen: checkout.taxYen, totalYen: checkout.totalYen,
    items: [...checkout.items].sort((left, right) => left.lineNumber - right.lineNumber).map((item) => ({
      label: cleanStoredLine(item.label), quantity: item.quantity, unitPriceYen: item.unitPriceYen,
      discountYen: item.discountYen, pointsDiscountYen: item.pointsDiscountYen, taxRate: item.taxRate, taxYen: item.taxYen, totalYen: item.totalYen
    })),
    taxBreakdown: checkout.taxBreakdown,
    payments: checkout.payments.map(({ method, amountYen }) => ({ method, amountYen }))
      .sort((left, right) => left.method.localeCompare(right.method) || left.amountYen - right.amountYen)
  });
  cashAssert(result.success, "RECEIPT_UNAVAILABLE", "会計の領収書情報を確認してください。", 409);
  buildReceiptEmail(result.data);
  return result.data;
}

function dateTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
const money = (amount: number) => `￥${amount.toLocaleString("ja-JP")}`;
const paymentLabels: Record<ReceiptSnapshot["payments"][number]["method"], string> = {
  CASH: "現金", CARD: "カード", BANK: "銀行振込", EXTERNAL_PREPAYMENT: "事前入金", OTHER: "その他"
};

/** Both preview and delivery render the captured snapshot through this function. */
export function buildReceiptEmail(input: ReceiptSnapshot): { subject: string; text: string } {
  const receipt = receiptSnapshotSchema.parse(input);
  if (receipt.documentVersion === 1) {
    const subject = `【領収書PDF】${receipt.issuerName}`;
    if (subject.length > 160) throw new CashError("RECEIPT_CONTENT_TOO_LONG", "店舗名がメール送信の上限を超えています。店舗名を確認してください。", 409);
    return {
      subject,
      text: [
        `${receipt.recipientName} 様`, "", "ご利用いただきありがとうございます。", "施術の領収書をPDFで添付いたします。",
        "", `領収書番号: ${receipt.receiptNumber}`, `領収金額（税込）: ${money(receipt.totalYen)}`,
        `発行事業者: ${receipt.issuerLegalName}`, `登録番号: ${receipt.invoiceRegistrationNumber}`,
        "", "宛名・明細・税率別内訳は添付PDFをご確認ください。", "領収書PDFはお手元に保存してご利用ください。"
      ].join("\n")
    };
  }
  const hasPoints = (receipt.pointsDiscountYen ?? 0) > 0;
  const subject = `【領収書】${receipt.issuerName}`;
  const text = [
    `${receipt.recipientName} 様`, "", "領収書", `領収書番号: ${receipt.receiptNumber}`,
    `領収日: ${dateTime(receipt.paidAt, receipt.timezone)}`, `ご予約日時: ${dateTime(receipt.treatmentAt, receipt.timezone)}`,
    `発行元: ${receipt.issuerName}`, "", `領収金額（税込）: ${money(receipt.totalYen)}`, `但し書き: ${receipt.description}`,
    "上記の金額を領収しました。", "", "明細（税込）",
    ...receipt.items.flatMap((item, index) => [
      `${index + 1}. ${item.label}`,
      `   単価 ${money(item.unitPriceYen)} × ${item.quantity} / ${hasPoints ? "通常値引き" : "値引き"} ${money(item.discountYen)}${hasPoints ? ` / ポイント利用値引き ${money(item.pointsDiscountYen ?? 0)}` : ""} / 金額 ${money(item.totalYen)}（税率 ${item.taxRate}%）`
    ]),
    "", `小計（税込）: ${money(receipt.subtotalYen)}`, `${hasPoints ? "通常値引き" : "値引き"}: ${money(receipt.discountYen)}`,
    ...(hasPoints ? [`ポイント利用値引き: ${money(receipt.pointsDiscountYen!)}`] : []),
    `合計（税込）: ${money(receipt.totalYen)}`, `うち消費税: ${money(receipt.taxYen)}`, "", "税率別内訳",
    ...receipt.taxBreakdown.map((group) => `${group.taxRate}%対象（税込）: ${money(group.taxableTotalYen)} / うち消費税 ${money(group.taxYen)}`),
    "", "お支払い内訳", ...receipt.payments.map((payment) => `${paymentLabels[payment.method]}: ${money(payment.amountYen)}`),
    "", "このメールを領収書として保管してください。"
  ].join("\n");
  if (subject.length > 160 || text.length > 10_000) {
    throw new CashError("RECEIPT_CONTENT_TOO_LONG", "領収書の内容がメール送信の上限を超えています。店舗名・明細を確認してください。", 409);
  }
  return { subject, text };
}
