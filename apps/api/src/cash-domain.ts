import { createHash } from "node:crypto";
import { z } from "zod";

export const CASH_MAX_YEN = 100_000_000;
const yen = z.number().int().min(0).max(CASH_MAX_YEN);
export const cashPaymentMethods = ["CASH", "CARD", "BANK", "EXTERNAL_PREPAYMENT", "OTHER"] as const;
export const cashMembershipInputShape = {
  membershipAccountId: z.string().min(1).max(160).nullable().optional(),
  pointUseDecision: z.enum(["USE", "SKIP"]).nullable().optional(),
  pointsToUse: z.number().int().min(0).max(CASH_MAX_YEN).optional(),
  pointPolicyVersion: z.string().min(1).max(100).nullable().optional()
};
export const cashDraftSchema = z.object({
  version: z.number().int().positive(),
  items: z.array(z.object({
    label: z.string().trim().min(1).max(160),
    quantity: z.number().int().min(1).max(999),
    unitPriceYen: yen,
    discountYen: yen,
    taxRate: z.union([z.literal(0), z.literal(8), z.literal(10)])
  }).strict()).min(1).max(100),
  payments: z.array(z.object({
    method: z.enum(cashPaymentMethods), amountYen: yen.refine((amount) => amount > 0),
    reference: z.string().trim().max(160).default("")
  }).strict()).max(20),
  pointsDiscountYen: yen.default(0),
  ...cashMembershipInputShape,
  legacyPaidAcknowledged: z.boolean(),
  notes: z.string().trim().max(2000).default("")
}).strict();

export type CashDraft = z.infer<typeof cashDraftSchema>;
export type CashMembershipSelection = {
  membershipAccountId: string; pointUseDecision: "USE" | "SKIP"; pointsToUse: number; pointPolicyVersion: string;
};
type CashMembershipFields = Pick<CashDraft, "membershipAccountId" | "pointsToUse" | "pointPolicyVersion"> & { pointUseDecision?: string | null };
export type CashItem = CashDraft["items"][number] & { lineNumber: number; pointsDiscountYen: number; taxYen: number; totalYen: number };
export type CashTotals = {
  items: CashItem[];
  subtotalYen: number;
  discountYen: number;
  pointsDiscountYen: number;
  taxYen: number;
  totalYen: number;
  cashYen: number;
  allocatedYen: number;
  taxBreakdown: { taxRate: number; taxableTotalYen: number; taxYen: number }[];
};

export class CashError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}

export function cashAssert(condition: unknown, code: string, message: string, statusCode = 400): asserts condition {
  if (!condition) throw new CashError(code, message, statusCode);
}

/** Older clients may omit membership fields; they must not silently detach a saved member. */
export function resolveCashMembershipSelection(input: CashMembershipFields, previous: CashMembershipFields = {}): CashMembershipSelection | null {
  if (input.membershipAccountId === null) {
    cashAssert(input.pointUseDecision == null && (input.pointsToUse ?? 0) === 0 && input.pointPolicyVersion == null,
      "CASH_MEMBER_SELECTION_INVALID", "会員を外す場合はポイント利用の選択も解除してください。");
    return null;
  }
  const accountId = input.membershipAccountId ?? previous.membershipAccountId;
  const changedAccount = input.membershipAccountId !== undefined && input.membershipAccountId !== previous.membershipAccountId;
  const decision = input.pointUseDecision !== undefined ? input.pointUseDecision : changedAccount ? null : previous.pointUseDecision;
  const pointsToUse = input.pointsToUse !== undefined ? input.pointsToUse : changedAccount ? undefined : previous.pointsToUse;
  const policyVersion = input.pointPolicyVersion !== undefined ? input.pointPolicyVersion : changedAccount ? null : previous.pointPolicyVersion;
  if (!accountId) {
    cashAssert(decision == null && (pointsToUse ?? 0) === 0 && policyVersion == null,
      "CASH_MEMBER_SELECTION_INVALID", "ポイント利用には会員証の読み取りと会員確認が必要です。");
    return null;
  }
  cashAssert((decision === "USE" || decision === "SKIP") && Number.isSafeInteger(pointsToUse) && pointsToUse! >= 0 && typeof policyVersion === "string" && policyVersion.length > 0,
    "CASH_MEMBER_DECISION_REQUIRED", "利用ポイントを確認してください。利用しない場合は0を入力してください。");
  return { membershipAccountId: accountId, pointUseDecision: decision, pointsToUse: pointsToUse!, pointPolicyVersion: policyVersion };
}

/** A linked membership controls the yen discount; legacy hand-entered yen discounts stay separate. */
export function membershipDiscountYen(selection: CashMembershipSelection, policy: { version: string; pointValueYen: number; redemptionUnit: number }) {
  cashAssert(selection.pointPolicyVersion === policy.version, "CASH_POINT_POLICY_CHANGED", "ポイントの利用条件が更新されています。会員情報を再確認してください。", 409);
  cashAssert(selection.pointUseDecision === "SKIP" ? selection.pointsToUse === 0 : selection.pointsToUse > 0 && selection.pointsToUse % policy.redemptionUnit === 0,
    "CASH_POINT_UNIT_INVALID", `ポイントは${policy.redemptionUnit}ポイント単位で指定してください。使わない場合は0ポイントにしてください。`);
  const discount = selection.pointsToUse * policy.pointValueYen;
  cashAssert(Number.isSafeInteger(discount) && discount >= 0 && discount <= CASH_MAX_YEN,
    "CASH_POINTS_DISCOUNT_LIMIT", "ポイント利用額が取扱上限を超えています。");
  return discount;
}

export function assertMembershipPrepayment(selection: CashMembershipSelection | null, paymentStatus: string) {
  cashAssert(!selection || selection.pointUseDecision !== "USE" || paymentStatus !== "PAID",
    "CASH_PREPAID_POINT_USE_UNAVAILABLE", "入金済みの予約では新しくポイントを利用できません。利用ポイントを0にしてください。", 409);
}

function sumBounded(values: number[]) {
  const result = values.reduce((sum, value) => sum + value, 0);
  cashAssert(Number.isSafeInteger(result) && result >= 0 && result <= CASH_MAX_YEN,
    "CASH_AMOUNT_LIMIT", "金額が取扱上限を超えています。");
  return result;
}

/** All entered prices are tax-inclusive. Round once per tax rate per receipt. */
export function calculateCashDraft(input: Pick<CashDraft, "items" | "payments"> & Partial<Pick<CashDraft, "pointsDiscountYen">>): CashTotals {
  const items: CashItem[] = input.items.map((item, lineNumber) => {
    const gross = item.quantity * item.unitPriceYen;
    cashAssert(Number.isSafeInteger(gross) && gross <= CASH_MAX_YEN,
      "CASH_AMOUNT_LIMIT", "明細金額が取扱上限を超えています。");
    cashAssert(item.discountYen <= gross, "CASH_DISCOUNT_LIMIT", "値引き額が明細金額を超えています。");
    const totalYen = gross - item.discountYen;
    return { ...item, lineNumber, pointsDiscountYen: 0, totalYen, taxYen: 0 };
  });
  const subtotalYen = sumBounded(items.map((item) => item.quantity * item.unitPriceYen));
  const discountYen = sumBounded(items.map((item) => item.discountYen));
  const afterDiscountYen = subtotalYen - discountYen;
  const pointsDiscountYen = input.pointsDiscountYen ?? 0;
  cashAssert(Number.isSafeInteger(pointsDiscountYen) && pointsDiscountYen >= 0 && pointsDiscountYen <= afterDiscountYen,
    "CASH_POINTS_DISCOUNT_LIMIT", "ポイント利用額は通常値引き後の金額以内で入力してください。");
  // Products can exceed Number.MAX_SAFE_INTEGER at the allowed 100-million-yen
  // limit. BigInt keeps proportional allocation and its tie-break exact.
  if (pointsDiscountYen > 0) {
    const denominator = BigInt(afterDiscountYen);
    const allocation = items.map((item) => {
      const numerator = BigInt(pointsDiscountYen) * BigInt(item.totalYen);
      item.pointsDiscountYen = Number(numerator / denominator);
      return { item, remainder: numerator % denominator };
    });
    let remainder = pointsDiscountYen - items.reduce((sum, item) => sum + item.pointsDiscountYen, 0);
    allocation.sort((left, right) => left.remainder === right.remainder ? left.item.lineNumber - right.item.lineNumber : left.remainder > right.remainder ? -1 : 1);
    for (const { item } of allocation) if (remainder > 0) { item.pointsDiscountYen++; remainder--; }
  }
  for (const item of items) {
    item.totalYen -= item.pointsDiscountYen;
    item.taxYen = Math.floor(item.totalYen * item.taxRate / (100 + item.taxRate));
  }
  const totalYen = afterDiscountYen - pointsDiscountYen;
  const taxBreakdown = [0, 8, 10].filter((rate) => items.some((item) => item.taxRate === rate)).map((taxRate) => {
    const rows = items.filter((item) => item.taxRate === taxRate);
    const taxableTotalYen = sumBounded(rows.map((item) => item.totalYen));
    const taxYen = Math.floor(taxableTotalYen * taxRate / (100 + taxRate));
    // Allocate the group-rounding remainder deterministically to line snapshots.
    let remainder = taxYen - rows.reduce((sum, item) => sum + item.taxYen, 0);
    for (const item of rows) if (remainder > 0) { item.taxYen++; remainder--; }
    return { taxRate, taxableTotalYen, taxYen };
  });
  return { items, subtotalYen, discountYen, pointsDiscountYen, totalYen, taxBreakdown,
    taxYen: taxBreakdown.reduce((sum, group) => sum + group.taxYen, 0),
    allocatedYen: sumBounded(input.payments.map((payment) => payment.amountYen)),
    cashYen: sumBounded(input.payments.filter((payment) => payment.method === "CASH").map((payment) => payment.amountYen)) };
}

export function assertCashSettlement(draft: Pick<CashDraft, "payments" | "legacyPaidAcknowledged">, totals: CashTotals, reservationPaymentStatus: string, allowRecheckout = false) {
  cashAssert(totals.allocatedYen === totals.totalYen, "CASH_PAYMENT_MISMATCH", "支払内訳の合計を会計金額と一致させてください。");
  const external = draft.payments.filter((payment) => payment.method === "EXTERNAL_PREPAYMENT");
  if (external.length || reservationPaymentStatus === "PAID") {
    cashAssert(draft.legacyPaidAcknowledged, "CASH_PREPAYMENT_ACK_REQUIRED", "既存の入金を確認したうえで、事前入金の記録として登録してください。");
    cashAssert(external.every((payment) => payment.reference.length > 0), "CASH_PREPAYMENT_REFERENCE_REQUIRED", "事前入金の確認番号または確認内容を入力してください。");
  }
  if (reservationPaymentStatus === "PAID") {
    cashAssert(draft.payments.every((payment) => payment.method === "EXTERNAL_PREPAYMENT"),
      "CASH_ALREADY_PAID", "入金済み予約は事前入金の記録のみ登録できます。追加の回収は行えません。", 409);
  }
  cashAssert(reservationPaymentStatus !== "REFUNDED" || allowRecheckout, "CASH_RESERVATION_REFUNDED", "返金済み予約には訂正元の会計記録が必要です。", 409);
}

export function expectedCash(openingCashYen: number, movements: { kind: string; amountYen: number }[]) {
  const result = movements.reduce((sum, movement) => sum + (["IN", "SALE"].includes(movement.kind) ? movement.amountYen : -movement.amountYen), openingCashYen);
  cashAssert(Number.isSafeInteger(result) && Math.abs(result) <= CASH_MAX_YEN,
    "REGISTER_AMOUNT_LIMIT", "レジの金額が取扱上限を超えています。");
  return result;
}

export function businessDateAt(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function cashRequestHash(value: unknown) {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
    return input;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function assertCashVersion(current: { status: string; version: number }, version: number, allowedStatus: string) {
  cashAssert(current.status === allowedStatus, "CASH_RECORD_SETTLED", "確定・締め済みの記録は変更できません。", 409);
  cashAssert(current.version === version, "CASH_VERSION_CONFLICT", "別の操作で更新されました。最新の画面を開き直してください。", 409);
}
