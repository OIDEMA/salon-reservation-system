import assert from "node:assert/strict";
import { test } from "node:test";
import { CashError, calculateCashDraft, cashDraftSchema } from "../src/cash-domain.js";
import { buildReceiptEmail, createReceiptSnapshot, receiptInputSchema, receiptPayloadSchema } from "../src/receipt-email.js";

const checkoutId = "102e7470-74df-4cab-822f-a3c532a77d00";
const requestId = "7b1c75ba-41fe-48fe-902f-54b0eb35f035";
function finalizedCheckout() {
  return {
    id: checkoutId, status: "FINALIZED" as const, finalizedAt: new Date("2026-10-23T05:20:00.000Z"),
    reservationSnapshot: { salonName: "東京店", startsAt: "2026-10-23T04:00:00.000Z", timezone: "Asia/Tokyo",
      customerId: "private-customer-id", staffName: "private-staff-name", customerName: "private-customer-name" },
    subtotalYen: 5500, discountYen: 100, pointsDiscountYen: 0, taxYen: 490, totalYen: 5400,
    taxBreakdown: [{ taxRate: 10, taxableTotalYen: 5400, taxYen: 490 }],
    items: [{ lineNumber: 0, label: "カット", quantity: 1, unitPriceYen: 5500, discountYen: 100, pointsDiscountYen: 0, taxRate: 10, taxYen: 490, totalYen: 5400 }],
    payments: [{ method: "CARD" as const, amountYen: 5400, reference: "private-card-reference" }],
    notes: "private-cash-notes"
  };
}
const input = { requestId, version: 2, recipientEmail: "customer@example.com", recipientName: "山田 花子", description: "施術代として" };

test("receipt contains captured finalized amounts, Japanese dates and only customer-facing fields", () => {
  const receipt = createReceiptSnapshot(finalizedCheckout(), input);
  const message = buildReceiptEmail(receipt);
  assert.equal(receipt.receiptNumber, checkoutId);
  assert.equal(receipt.paidAt, "2026-10-23T05:20:00.000Z");
  assert.equal(message.subject, "【領収書】東京店");
  assert.match(message.text, /山田 花子 様/);
  assert.match(message.text, /領収日: 2026\/10\/23 14:20/);
  assert.match(message.text, /ご予約日時: 2026\/10\/23 13:00/);
  assert.match(message.text, /領収金額（税込）: ￥5,400/);
  assert.match(message.text, /うち消費税: ￥490/);
  assert.match(message.text, /カード: ￥5,400/);
  assert.match(message.text, /カット/);
  assert.doesNotMatch(JSON.stringify(receipt) + message.text, /private-|reference|customerId|staffName|notes/);
  assert.doesNotMatch(message.text, /適格請求書|インボイス登録/);
});

test("receipt snapshot remains fixed after later source edits and uses store timezone", () => {
  const checkout = finalizedCheckout();
  checkout.reservationSnapshot.timezone = "America/New_York";
  const receipt = createReceiptSnapshot(checkout, input);
  const before = buildReceiptEmail(receipt);
  checkout.items[0]!.label = "後の変更";
  checkout.items[0]!.totalYen = 10;
  checkout.taxBreakdown[0]!.taxYen = 0;
  checkout.payments[0]!.amountYen = 10;
  checkout.reservationSnapshot.salonName = "別の店名";
  assert.deepEqual(buildReceiptEmail(receipt), before);
  assert.match(before.text, /領収日: 2026\/10\/23 01:20/);
  assert.equal(receipt.taxBreakdown[0]!.taxYen, 490);
  assert.equal(receipt.payments[0]!.amountYen, 5400);
});

test("point-discounted receipt preserves separate discounts, mixed-tax net totals and actual payment", () => {
  const draft = cashDraftSchema.parse({ version: 1, legacyPaidAcknowledged: false, pointsDiscountYen: 180,
    items: [{ label: "施術", quantity: 1, unitPriceYen: 1200, discountYen: 100, taxRate: 10 },
      { label: "店販", quantity: 1, unitPriceYen: 1080, discountYen: 0, taxRate: 8 }],
    payments: [{ method: "CARD", amountYen: 2000, reference: "private-payment-reference" }]
  });
  const totals = calculateCashDraft(draft);
  const receipt = createReceiptSnapshot({ ...finalizedCheckout(), ...totals, payments: draft.payments }, input);
  const message = buildReceiptEmail(receipt);
  assert.deepEqual([receipt.subtotalYen, receipt.discountYen, receipt.pointsDiscountYen, receipt.totalYen, receipt.taxYen], [2280, 100, 180, 2000, 164]);
  assert.deepEqual(receipt.items.map((item) => item.pointsDiscountYen), [91, 89]);
  assert.match(message.text, /領収金額（税込）: ￥2,000/);
  assert.match(message.text, /通常値引き: ￥100/); assert.match(message.text, /ポイント利用値引き: ￥180/);
  assert.match(message.text, /カード: ￥2,000/); assert.match(message.text, /うち消費税: ￥164/);
  assert.doesNotMatch(message.text, /private-payment-reference/);
  const payload = { checkoutId, requestId, requestHash: "a".repeat(64), receipt };
  for (const mismatch of [{ pointsDiscountYen: 181 }, { pointsDiscountYen: undefined }, { pointsDiscountYen: -1 },
    { totalYen: 2180 }, { items: receipt.items.map((item) => ({ ...item, pointsDiscountYen: 0 })) },
    { payments: [{ method: "CARD", amountYen: 2180 }] }]) {
    assert.equal(receiptPayloadSchema.safeParse({ ...payload, receipt: { ...receipt, ...mismatch } }).success, false);
  }
});

test("all-points receipt records zero yen collected and no invented payment", () => {
  const draft = cashDraftSchema.parse({ version: 1, legacyPaidAcknowledged: false, pointsDiscountYen: 1000,
    items: [{ label: "施術", quantity: 1, unitPriceYen: 1100, discountYen: 100, taxRate: 10 }], payments: [] });
  const receipt = createReceiptSnapshot({ ...finalizedCheckout(), ...calculateCashDraft(draft), payments: draft.payments }, input);
  assert.equal(receipt.totalYen, 0); assert.equal(receipt.taxYen, 0); assert.deepEqual(receipt.payments, []);
  const message = buildReceiptEmail(receipt);
  assert.match(message.text, /領収金額（税込）: ￥0/); assert.match(message.text, /ポイント利用値引き: ￥1,000/);
  assert.doesNotMatch(message.text, /カード:|現金:/);
});

test("already queued receipts without point fields keep their payload and rendered text", () => {
  const current = createReceiptSnapshot(finalizedCheckout(), input);
  const { pointsDiscountYen: _points, ...withoutPoints } = current;
  const legacy = { ...withoutPoints, items: current.items.map(({ pointsDiscountYen: _linePoints, ...item }) => item) };
  const payload = { checkoutId, requestId, requestHash: "a".repeat(64), receipt: legacy };
  assert.deepEqual(receiptPayloadSchema.parse(payload), payload);
  assert.deepEqual(buildReceiptEmail(legacy), buildReceiptEmail(current));
  assert.doesNotMatch(buildReceiptEmail(legacy).text, /ポイント|通常値引き/);
});

test("missing timezone uses Japan and safe stored line breaks cannot inject receipt headings", () => {
  const checkout = finalizedCheckout();
  delete (checkout.reservationSnapshot as { timezone?: string }).timezone;
  checkout.items[0]!.label = "カット\n秘密の追記\t";
  const receipt = createReceiptSnapshot(checkout, input);
  assert.equal(receipt.timezone, "Asia/Tokyo");
  assert.equal(receipt.items[0]!.label, "カット 秘密の追記");
});

test("preview and queued message keep the same payment order regardless of database row order", () => {
  const checkout = finalizedCheckout();
  const payments = [
    { method: "CASH" as const, amountYen: 1400, reference: "private-cash-reference" },
    { method: "CARD" as const, amountYen: 4000, reference: "private-card-reference" }
  ];
  const before = buildReceiptEmail(createReceiptSnapshot({ ...checkout, payments }, input));
  const after = buildReceiptEmail(createReceiptSnapshot({ ...checkout, payments: [...payments].reverse() }, input));
  assert.deepEqual(after, before);
});

test("receipt inputs trim outer spaces, require idempotency/version, and reject controls even at boundaries", () => {
  assert.deepEqual(receiptInputSchema.parse({ ...input, recipientEmail: " customer@example.com ", recipientName: " 山田 花子 ", description: " 施術代として " }), input);
  for (const key of ["recipientEmail", "recipientName", "description"] as const) {
    for (const control of ["\r", "\n", "\t", "\0", "\u007f", "\u2028"]) {
      assert.equal(receiptInputSchema.safeParse({ ...input, [key]: control + input[key] }).success, false, `${key} with ${JSON.stringify(control)}`);
    }
  }
  for (const bad of [{ ...input, unexpected: true }, { ...input, requestId: "not-a-uuid" }, { ...input, version: 0 },
    { ...input, recipientName: " " }, { ...input, description: "x".repeat(201) }, { ...input, recipientEmail: "wrong" }]) {
    assert.equal(receiptInputSchema.safeParse(bad).success, false);
  }
});

test("receipt requires finalized checkout and complete receipt information", () => {
  const checkout = finalizedCheckout();
  for (const invalid of [{ ...checkout, status: "REVERSED" as const }, { ...checkout, status: "DRAFT" as const },
    { ...checkout, finalizedAt: null }, { ...checkout, reservationSnapshot: {} }, { ...checkout, items: [] }]) {
    assert.throws(() => createReceiptSnapshot(invalid, input), (error: unknown) => error instanceof CashError && error.code === "RECEIPT_UNAVAILABLE");
  }
});

test("oversized receipt bodies and subjects are rejected before queueing, never truncated", () => {
  const checkout = finalizedCheckout();
  checkout.items = Array.from({ length: 100 }, (_, lineNumber) => ({ ...checkout.items[0]!, lineNumber, label: "長".repeat(160),
    ...(lineNumber === 0 ? {} : { unitPriceYen: 0, discountYen: 0, taxYen: 0, totalYen: 0 }) }));
  assert.throws(() => createReceiptSnapshot(checkout, input), (error: unknown) => error instanceof CashError && error.code === "RECEIPT_CONTENT_TOO_LONG");
  const longIssuer = finalizedCheckout();
  longIssuer.reservationSnapshot.salonName = "店".repeat(160);
  assert.throws(() => createReceiptSnapshot(longIssuer, input), (error: unknown) => error instanceof CashError && error.code === "RECEIPT_CONTENT_TOO_LONG");
});

test("payload allowlist rejects accidental internal data and malformed snapshot metadata", () => {
  const payload = { checkoutId, requestId, requestHash: "a".repeat(64), receipt: createReceiptSnapshot(finalizedCheckout(), input) };
  assert.equal(receiptPayloadSchema.safeParse(payload).success, true);
  assert.equal(receiptPayloadSchema.safeParse({ ...payload, receipt: { ...payload.receipt, notes: "internal" } }).success, false);
  assert.equal(receiptPayloadSchema.safeParse({ ...payload, requestHash: "bad" }).success, false);
  assert.equal(receiptPayloadSchema.safeParse({ ...payload, receipt: { ...payload.receipt, timezone: "wrong/timezone" } }).success, false);
  assert.equal(receiptPayloadSchema.safeParse({ ...payload, receipt: { ...payload.receipt, totalYen: 999 } }).success, false);
  assert.equal(receiptPayloadSchema.safeParse({ ...payload, receipt: { ...payload.receipt, payments: [{ method: "CASH", amountYen: 1 }] } }).success, false);
  assert.equal(receiptPayloadSchema.safeParse({ ...payload, receipt: { ...payload.receipt, taxBreakdown: [{ taxRate: 10, taxableTotalYen: 5400, taxYen: 100 }] } }).success, false);
});
