import test from "node:test";
import assert from "node:assert/strict";
import { assertCashSettlement, assertCashVersion, businessDateAt, calculateCashDraft,
  cashDraftSchema, cashRequestHash, expectedCash } from "../src/cash-domain.js";

const draft = (overrides: Record<string, unknown> = {}) => cashDraftSchema.parse({ version: 1,
  items: [{ label: "フェイシャルケア", quantity: 1, unitPriceYen: 9800, discountYen: 0, taxRate: 10 }],
  payments: [{ method: "CASH", amountYen: 9800 }], legacyPaidAcknowledged: false, notes: "", ...overrides });

test("tax-inclusive snapshots preserve exact yen and round once per receipt tax rate", () => {
  const input = draft({ items: [
    { label: "10% A", quantity: 1, unitPriceYen: 6, discountYen: 0, taxRate: 10 },
    { label: "10% B", quantity: 1, unitPriceYen: 6, discountYen: 0, taxRate: 10 },
    { label: "8%", quantity: 1, unitPriceYen: 1080, discountYen: 0, taxRate: 8 }
  ], payments: [{ method: "CARD", amountYen: 1092 }] });
  const totals = calculateCashDraft(input);
  assert.equal(totals.totalYen, 1092);
  assert.equal(totals.taxYen, 81);
  assert.deepEqual(totals.taxBreakdown, [
    { taxRate: 8, taxableTotalYen: 1080, taxYen: 80 }, { taxRate: 10, taxableTotalYen: 12, taxYen: 1 }
  ]);
  assert.equal(totals.items.reduce((sum, item) => sum + item.taxYen, 0), totals.taxYen);
  assert.equal(input.items[0].unitPriceYen, 6);
  const combined = calculateCashDraft(draft({ items: [{ label: "10% combined", quantity: 2, unitPriceYen: 6, discountYen: 0, taxRate: 10 }], payments: [] }));
  assert.equal(combined.taxYen, 1);
});

test("quantity and line discount affect the net paid total and tax without floating-point currency", () => {
  const totals = calculateCashDraft(draft({ items: [{ label: "ケア", quantity: 2, unitPriceYen: 1100, discountYen: 200, taxRate: 10 }], payments: [] }));
  assert.equal(totals.subtotalYen, 2200);
  assert.equal(totals.discountYen, 200);
  assert.equal(totals.totalYen, 2000);
  assert.equal(totals.taxYen, 181);
});

test("drafts may have incomplete allocations but finalization requires exact payment totals", () => {
  for (const amountYen of [9799, 9801]) {
    const input = draft({ payments: [{ method: "CASH", amountYen }] });
    assert.throws(() => assertCashSettlement(input, calculateCashDraft(input), "UNPAID"), { code: "CASH_PAYMENT_MISMATCH" });
  }
  const split = draft({ payments: [{ method: "CASH", amountYen: 4800 }, { method: "CARD", amountYen: 5000, reference: "端末確認済み" }] });
  assert.doesNotThrow(() => assertCashSettlement(split, calculateCashDraft(split), "UNPAID"));
  assert.equal(calculateCashDraft(split).cashYen, 4800);
});

test("a zero-value settlement needs no invented cash payment", () => {
  const free = draft({ items: [{ label: "無料ケア", quantity: 1, unitPriceYen: 500, discountYen: 500, taxRate: 10 }], payments: [] });
  assert.doesNotThrow(() => assertCashSettlement(free, calculateCashDraft(free), "UNPAID"));
  assert.equal(calculateCashDraft(free).taxYen, 0);
});

test("legacy PAID never silently creates a second cash or card collection", () => {
  const cash = draft({ legacyPaidAcknowledged: true });
  assert.throws(() => assertCashSettlement(cash, calculateCashDraft(cash), "PAID"), { code: "CASH_ALREADY_PAID" });
  const external = draft({ payments: [{ method: "EXTERNAL_PREPAYMENT", amountYen: 9800, reference: "事前入金控え123" }] });
  assert.throws(() => assertCashSettlement(external, calculateCashDraft(external), "PAID"), { code: "CASH_PREPAYMENT_ACK_REQUIRED" });
  external.legacyPaidAcknowledged = true;
  assert.doesNotThrow(() => assertCashSettlement(external, calculateCashDraft(external), "PAID"));
  external.payments[0].reference = "";
  assert.throws(() => assertCashSettlement(external, calculateCashDraft(external), "PAID"), { code: "CASH_PREPAYMENT_REFERENCE_REQUIRED" });
});

test("a refunded reservation needs an explicitly linked reversed checkout to settle again", () => {
  const input = draft();
  assert.throws(() => assertCashSettlement(input, calculateCashDraft(input), "REFUNDED"), { code: "CASH_RESERVATION_REFUNDED" });
  assert.doesNotThrow(() => assertCashSettlement(input, calculateCashDraft(input), "REFUNDED", true));
});

test("invalid yen, quantities, taxes, over-discounts, and overflow never become snapshots", () => {
  for (const unitPriceYen of [-1, 1.5, 100_000_001]) {
    assert.throws(() => draft({ items: [{ label: "ケア", quantity: 1, unitPriceYen, discountYen: 0, taxRate: 10 }] }));
  }
  assert.throws(() => draft({ items: [{ label: "ケア", quantity: 0, unitPriceYen: 100, discountYen: 0, taxRate: 10 }] }));
  assert.throws(() => draft({ items: [{ label: "ケア", quantity: 1, unitPriceYen: 100, discountYen: 0, taxRate: 5 }] }));
  assert.throws(() => calculateCashDraft(draft({ items: [{ label: "ケア", quantity: 1, unitPriceYen: 100, discountYen: 101, taxRate: 10 }] })), { code: "CASH_DISCOUNT_LIMIT" });
  assert.throws(() => calculateCashDraft(draft({ items: [{ label: "ケア", quantity: 999, unitPriceYen: 100_000_000, discountYen: 0, taxRate: 10 }] })), { code: "CASH_AMOUNT_LIMIT" });
  assert.throws(() => cashDraftSchema.parse({ ...draft(), totalYen: 1 }));
});

test("expected cash counts cash receipts, manual movements, and refunds only", () => {
  const movements = [{ kind: "SALE", amountYen: 9800 }, { kind: "IN", amountYen: 100 }, { kind: "OUT", amountYen: 500 }, { kind: "REFUND", amountYen: 9800 }];
  assert.equal(expectedCash(10000, movements), 9600);
  assert.throws(() => expectedCash(100_000_000, [{ kind: "SALE", amountYen: 1 }]), { code: "REGISTER_AMOUNT_LIMIT" });
});

test("closed or finalized records and stale versions cannot be updated", () => {
  assert.doesNotThrow(() => assertCashVersion({ status: "DRAFT", version: 2 }, 2, "DRAFT"));
  assert.throws(() => assertCashVersion({ status: "DRAFT", version: 2 }, 1, "DRAFT"), { code: "CASH_VERSION_CONFLICT", statusCode: 409 });
  assert.throws(() => assertCashVersion({ status: "FINALIZED", version: 2 }, 2, "DRAFT"), { code: "CASH_RECORD_SETTLED", statusCode: 409 });
  assert.throws(() => assertCashVersion({ status: "CLOSED", version: 2 }, 2, "OPEN"), { code: "CASH_RECORD_SETTLED", statusCode: 409 });
});

test("idempotency hashes ignore object-key order but preserve changed amounts and line order", () => {
  assert.equal(cashRequestHash({ version: 1, countedCashYen: 100 }), cashRequestHash({ countedCashYen: 100, version: 1 }));
  assert.notEqual(cashRequestHash({ countedCashYen: 100 }), cashRequestHash({ countedCashYen: 101 }));
  assert.notEqual(cashRequestHash(["A", "B"]), cashRequestHash(["B", "A"]));
});

test("the business date uses the salon timezone", () => {
  assert.equal(businessDateAt(new Date("2026-10-13T15:30:00Z"), "Asia/Tokyo"), "2026-10-14");
  assert.equal(businessDateAt(new Date("2026-10-13T15:30:00Z"), "UTC"), "2026-10-13");
});
