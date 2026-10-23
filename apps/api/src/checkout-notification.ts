import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { CASH_MAX_YEN, cashPaymentMethods } from "./cash-domain.js";

const amount = z.number().int().min(0).max(CASH_MAX_YEN);
const identifier = z.string().min(1).max(160);
export const checkoutNotificationSchema = z.object({
  version: z.literal(1), eventType: z.enum(["checkout.finalized", "checkout.reversed"]),
  tenantId: identifier, salonId: identifier, tenantSlug: identifier,
  checkoutId: z.string().uuid(), reservationId: identifier,
  salonName: z.string().min(1), customerName: z.string().min(1),
  serviceName: z.string().min(1), staffName: z.string().min(1),
  startsAt: z.string().datetime(), occurredAt: z.string().datetime(),
  subtotalYen: amount, discountYen: amount, pointsDiscountYen: amount, totalYen: amount, taxYen: amount,
  payments: z.array(z.object({ method: z.enum(cashPaymentMethods), amountYen: amount.refine((value) => value > 0) }).strict()).max(20)
}).strict().superRefine((payload, context) => {
  if (payload.subtotalYen - payload.discountYen - payload.pointsDiscountYen !== payload.totalYen ||
    payload.payments.reduce((sum, payment) => sum + payment.amountYen, 0) !== payload.totalYen || payload.taxYen > payload.totalYen) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Checkout notification amounts are inconsistent" });
  }
});

type Notification = z.infer<typeof checkoutNotificationSchema>;
type SnapshotCheckout = {
  id: string; tenantId: string; salonId: string; reservationId: string; reservationSnapshot: Prisma.JsonValue;
  status: string; finalizedAt: Date | null; reversedAt: Date | null;
  subtotalYen: number; discountYen: number; pointsDiscountYen: number; totalYen: number; taxYen: number;
  payments: { method: typeof cashPaymentMethods[number]; amountYen: number }[];
};

export async function enqueueCheckoutNotification(tx: Prisma.TransactionClient, input: {
  tenantId: string; salonId: string; tenantSlug: string; eventType: Notification["eventType"]; checkout: SnapshotCheckout;
}) {
  const { checkout, eventType, tenantId, salonId, tenantSlug } = input;
  if (checkout.tenantId !== tenantId || checkout.salonId !== salonId ||
    checkout.status !== (eventType === "checkout.finalized" ? "FINALIZED" : "REVERSED")) throw new Error("Invalid checkout notification scope");
  const settings = await tx.salonSettings.findUnique({ where: { tenantId_salonId: { tenantId, salonId } },
    select: { notifyReservationEmail: true, notificationEmail: true } });
  const recipient = settings?.notificationEmail?.trim();
  if (!settings?.notifyReservationEmail || !recipient || !z.string().email().max(254).safeParse(recipient).success) return;
  const snapshot = z.object({ salonName: z.string().min(1), customerName: z.string().min(1),
    serviceName: z.string().min(1), staffName: z.string().min(1), startsAt: z.string().datetime() }).parse(checkout.reservationSnapshot);
  const occurredAt = eventType === "checkout.finalized" ? checkout.finalizedAt : checkout.reversedAt;
  if (!occurredAt) throw new Error("Invalid checkout notification timestamp");
  const payload = checkoutNotificationSchema.parse({ version: 1, eventType, tenantId, salonId, tenantSlug,
    checkoutId: checkout.id, reservationId: checkout.reservationId, ...snapshot, occurredAt: occurredAt.toISOString(),
    subtotalYen: checkout.subtotalYen, discountYen: checkout.discountYen, pointsDiscountYen: checkout.pointsDiscountYen,
    totalYen: checkout.totalYen, taxYen: checkout.taxYen,
    payments: checkout.payments.map(({ method, amountYen }) => ({ method, amountYen })) });
  await tx.emailOutbox.create({ data: { eventKey: `${eventType}:${checkout.id}`, eventType, tenantId, salonId, recipientEmail: recipient, payload } });
}

function cleanLine(value: string) { return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim(); }
function japanDateTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
const paymentLabels = { CASH: "現金", CARD: "カード", BANK: "銀行振込", EXTERNAL_PREPAYMENT: "事前入金", OTHER: "その他" } as const;
const yen = (value: number) => `${value.toLocaleString("ja-JP")}円`;

export function checkoutNotificationEmail(payload: Notification, baseUrl: string) {
  const reversed = payload.eventType === "checkout.reversed";
  const checkoutUrl = new URL(`/${encodeURIComponent(payload.tenantSlug)}/checkout/${encodeURIComponent(payload.checkoutId)}`, baseUrl).href;
  const payments = cashPaymentMethods.map((method) => ({ method,
    amountYen: payload.payments.filter((payment) => payment.method === method).reduce((sum, payment) => sum + payment.amountYen, 0)
  })).filter((payment) => payment.amountYen > 0);
  return {
    subject: `[SalonOps] ${reversed ? "会計取消" : "会計確定"}（${cleanLine(payload.salonName)}）`,
    text: [reversed ? "会計の全額取消・返金が記録されました。" : "会計が確定しました。",
      `店舗: ${cleanLine(payload.salonName)}`, `お客様名: ${cleanLine(payload.customerName)}`,
      `予約日時: ${japanDateTime(payload.startsAt)}`, `メニュー: ${cleanLine(payload.serviceName)}`, `担当: ${cleanLine(payload.staffName)}`,
      `${reversed ? "取消" : "確定"}日時: ${japanDateTime(payload.occurredAt)}`,
      `${reversed ? "取消した会計の" : ""}小計（税込）: ${yen(payload.subtotalYen)}`,
      `通常値引き: ${yen(payload.discountYen)}`, `ポイント利用値引き: ${yen(payload.pointsDiscountYen)}`,
      `${reversed ? "取消売上（税込）" : "確定売上（税込）"}: ${yen(payload.totalYen)}`, `内消費税: ${yen(payload.taxYen)}`,
      `${reversed ? "返金記録" : "支払記録"}合計: ${yen(payload.totalYen)}`,
      ...payments.map((payment) => `${reversed ? "返金" : "支払"}内訳・${paymentLabels[payment.method]}: ${yen(payment.amountYen)}`),
      ...(reversed ? [`この会計による売上計上は取り消されました（売上の増減: -${yen(payload.totalYen)}）。`,
        "ポイント利用値引きも取消となります。ポイント残高の返還が必要な場合は、別途ご確認ください。"] : []),
      `予約番号: ${cleanLine(payload.reservationId)}`, `会計番号: ${payload.checkoutId}`, `管理画面: ${checkoutUrl}`
    ].join("\n")
  };
}
