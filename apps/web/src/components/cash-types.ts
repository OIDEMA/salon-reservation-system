export type CashItem = { label: string; quantity: number; unitPriceYen: number; discountYen: number; pointsDiscountYen?: number; taxRate: number; taxYen?: number; totalYen?: number };
export type CashPayment = { method: "CASH" | "CARD" | "BANK" | "EXTERNAL_PREPAYMENT" | "OTHER"; amountYen: number; reference: string };
export type CashCheckout = {
  id: string; reservationId: string; status: "DRAFT" | "FINALIZED" | "REVERSED"; version: number;
  reservationSnapshot: { customerName: string; serviceName: string; staffName: string; salonName: string; startsAt: string };
  items: CashItem[]; payments: CashPayment[]; legacyPaymentStatus: string; legacyPaidAcknowledged: boolean;
  subtotalYen: number; discountYen: number; pointsDiscountYen?: number; taxYen: number; totalYen: number; cashYen: number; notes: string;
  taxBreakdown: { taxRate: number; taxableTotalYen: number; taxYen: number }[];
  finalizedAt: string | null; reversedAt: string | null; reversalReason: string | null;
};
export type CashMovement = { id: string; kind: "IN" | "OUT" | "SALE" | "REFUND"; amountYen: number; reason: string; createdAt: string };
export type CashRegister = {
  id: string; businessDate: string; status: "OPEN" | "CLOSED"; version: number;
  openingCashYen: number; expectedCashYen: number; countedCashYen: number | null; differenceYen: number | null;
  note: string; closedAt: string | null; movements: CashMovement[];
  closeSnapshot: null | { salesCount: number; refundsCount: number; salesTotalYen: number; refundsTotalYen: number;
    netTotalYen: number; discountYen: number; pointsDiscountYen?: number; refundsPointsDiscountYen?: number; taxYen: number; refundsTaxYen: number;
    paymentTotals: { method: string; salesYen: number; refundsYen: number; netYen: number }[] };
};
export const cashMethodLabels: Record<CashPayment["method"], string> = { CASH: "現金", CARD: "カード", BANK: "振込", EXTERNAL_PREPAYMENT: "確認済みの事前入金", OTHER: "その他" };
export const cashStatusLabels = { DRAFT: "下書き", FINALIZED: "確定", REVERSED: "全額取消済み" };
export const cashYen = (amount: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(amount);

export type CashCheckoutSummary = {
  id: string;
  reservationId: string;
  customerName: string;
  serviceName: string;
  status: CashCheckout["status"];
  totalYen: number;
  createdAt: string;
};
export type CashCheckoutPage = {
  checkouts: CashCheckoutSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type CashRegisterSummary = Pick<CashRegister,
  "id" | "businessDate" | "status" | "openingCashYen" | "expectedCashYen" | "differenceYen"
>;
export type CashRegisterPage = {
  registers: CashRegisterSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
