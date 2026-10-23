import type { PaymentStatus, ReservationSource, ReservationStatus } from "@prisma/client";
import { z } from "zod";
import { reservationPrice } from "./reservation-price.js";

const legacyPayload = z.object({
  reservationId: z.string().min(1), salonName: z.string().min(1), startsAt: z.string().datetime(),
  serviceName: z.string().min(1), tenantSlug: z.string().min(1)
}).strict();
const sourceLabels = { LINE: "LINE", MINI_APP: "会員アプリ", WEB: "Web", PHONE: "電話", WALK_IN: "直接来店" } as const;
const statusLabels = { PENDING: "未確認", CONFIRMED: "確定", ARRIVED: "来店", COMPLETED: "完了", CANCELLED: "取消", NO_SHOW: "無断キャンセル", WAITLIST: "キャンセル待ち" } as const;
const paymentLabels = { UNPAID: "未払い", AUTHORIZED: "与信済み", PAID: "支払済み", REFUNDED: "返金済み" } as const;
const detailedPayload = legacyPayload.extend({
  customerName: z.string().min(1), endsAt: z.string().datetime(), durationMinutes: z.number().int().positive(),
  reservationAmountYen: z.number().int().min(0).max(110_000_000), staffName: z.string().min(1).nullable(), isRequest: z.boolean(),
  source: z.enum(["LINE", "MINI_APP", "WEB", "PHONE", "WALK_IN"]),
  status: z.enum(["PENDING", "CONFIRMED", "ARRIVED", "COMPLETED", "CANCELLED", "NO_SHOW", "WAITLIST"]),
  paymentStatus: z.enum(["UNPAID", "AUTHORIZED", "PAID", "REFUNDED"])
}).strict().refine((value) => new Date(value.endsAt).getTime() - new Date(value.startsAt).getTime() === value.durationMinutes * 60_000,
  "Reservation duration must match the captured dates");

// Existing queued events contain only these five legacy fields. Keep their delivery intact.
export const reservationNotificationSchema = z.union([detailedPayload, legacyPayload]);
type SnapshotReservation = {
  id: string; startsAt: Date; endsAt: Date; customer: { name: string }; service: { name: string; price: number };
  staff: { name: string } | null; isRequest: boolean; source: ReservationSource; status: ReservationStatus; paymentStatus: PaymentStatus;
  memberBookingRequest?: { price: number } | null;
};

/** Capture booking-time values inside the creation transaction, before masters can change. */
export function reservationNotificationPayload(reservation: SnapshotReservation, salonName: string, tenantSlug: string) {
  return {
    reservationId: reservation.id, salonName, tenantSlug,
    startsAt: reservation.startsAt.toISOString(), endsAt: reservation.endsAt.toISOString(),
    durationMinutes: Math.round((reservation.endsAt.getTime() - reservation.startsAt.getTime()) / 60_000),
    customerName: reservation.customer.name, serviceName: reservation.service.name,
    reservationAmountYen: reservationPrice(reservation), staffName: reservation.staff?.name ?? null,
    isRequest: reservation.isRequest, source: reservation.source, status: reservation.status, paymentStatus: reservation.paymentStatus
  };
}
function cleanLine(value: string): string { return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim(); }
function japanDateTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
export function reservationNotificationEmail(payload: z.infer<typeof reservationNotificationSchema>, baseUrl: string) {
  const listUrl = new URL(`/${encodeURIComponent(payload.tenantSlug)}/reservations`, baseUrl).href;
  const details = "customerName" in payload ? [
    `お客様名: ${cleanLine(payload.customerName)}`,
    `日時: ${japanDateTime(payload.startsAt)} ～ ${japanDateTime(payload.endsAt)}（${payload.durationMinutes}分）`,
    `メニュー: ${cleanLine(payload.serviceName)}`,
    `担当: ${payload.staffName ? `${cleanLine(payload.staffName)}（${payload.isRequest ? "指名あり" : "指名なし"}）` : "指名なし（未割当）"}`,
    `予約金額（予定）: ${payload.reservationAmountYen.toLocaleString("ja-JP")}円`,
    "ポイント利用: 会計時に確認",
    `予約経路: ${sourceLabels[payload.source]}`,
    `予約状態: ${statusLabels[payload.status]}`,
    `支払状況: ${paymentLabels[payload.paymentStatus]}`,
    "※金額は予約時点の予定です。値引き・ポイント利用後の売上は会計時に確定します。"
  ] : [`日時: ${japanDateTime(payload.startsAt)}`, `メニュー: ${cleanLine(payload.serviceName)}`];
  return {
    subject: `[SalonOps] 新しい予約（${cleanLine(payload.salonName)}）`,
    text: ["新しい予約が入りました。", `店舗: ${cleanLine(payload.salonName)}`, ...details,
      `予約番号: ${cleanLine(payload.reservationId)}`, `管理画面: ${listUrl}`].join("\n")
  };
}
