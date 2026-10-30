import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { MembershipDetails, MembershipPointsInput } from "../src/components/membership-confirmation";
import { CashCheckoutEditor } from "../src/components/cash-views";
import type { CashCheckout, CashMembership } from "../src/components/cash-types";
import { TenantProvider } from "../src/components/tenant-provider";
import { membershipChoice, membershipDraftFields, membershipFromPointInput, membershipRedemptionLimit, membershipRequest, membershipSelectionForLookup, normalizeMembershipBarcode, readMembershipLookup, type MembershipLookup } from "../src/lib/membership-checkout";

const lookup: MembershipLookup = {
  member: { id: "member-1", number: "1000000000001", name: "会員確認のお客様", balance: 2480, availablePoints: 2480, qualifyingPoints: 2930 },
  linkStatus: "LINKED", customerId: "customer-1",
  policy: { version: "beautygum-20261029-v1", pointValueYen: 1, redemptionUnit: 100, earnYenUnit: 100, earnPoints: 5 },
  history: [{ id: "history-1", kind: "EARN", delta: 490, createdAt: "2026-10-29T03:00:00.000Z", salonName: "テスト店舗", checkoutId: "checkout-previous" }],
};

test("barcode accepts a reader's trailing Enter and rejects unrelated identifiers", () => {
  assert.equal(normalizeMembershipBarcode("1000000000001\r\n"), "1000000000001");
  assert.equal(normalizeMembershipBarcode("beautygum-demo:1000000000001"), "beautygum-demo:1000000000001");
  for (const value of ["", "100000000000", "10000000000011", "１０００００００００００１", "100 0000000001", "https://example.test/1000000000001", "<script>1000000000001</script>"]) {
    assert.throws(() => normalizeMembershipBarcode(value), /会員証/);
  }
});

test("malformed member responses cannot become a valid balance or point policy", () => {
  assert.deepEqual(readMembershipLookup(lookup), lookup);
  for (const value of [null, {}, { ...lookup, member: null }, { ...lookup, member: { ...lookup.member, balance: "2480" } },
    { ...lookup, member: { ...lookup.member, number: "10000000000011" } },
    { ...lookup, member: { ...lookup.member, availablePoints: -1 } }, { ...lookup, customerId: null },
    { ...lookup, policy: { ...lookup.policy, pointValueYen: 2 } }, { ...lookup, policy: { ...lookup.policy, redemptionUnit: 1 } },
    { ...lookup, history: [{ ...lookup.history[0], kind: "UNKNOWN" }] }, { ...lookup, history: [{ ...lookup.history[0], createdAt: "not-a-date" }] }]) {
    assert.throws(() => readMembershipLookup(value), /会員情報/);
  }
});

test("redemption rounds down to 100 and respects both balance and the after-discount amount", () => {
  assert.equal(membershipRedemptionLimit(lookup, 9800), 2400);
  assert.equal(membershipRedemptionLimit(lookup, 2399), 2300);
  assert.equal(membershipRedemptionLimit(lookup, 100), 100);
  assert.equal(membershipRedemptionLimit(lookup, 99), 0);
  assert.equal(membershipRedemptionLimit(lookup, 0), 0);
  assert.equal(membershipRedemptionLimit(lookup, -1), 0);
  assert.equal(membershipRedemptionLimit(lookup, 100.5), 0);
  assert.equal(membershipRedemptionLimit(lookup, NaN), 0);
  assert.equal(membershipRedemptionLimit({ ...lookup, member: { ...lookup.member, availablePoints: 1099 } }, 9800), 1000);
  assert.equal(membershipRedemptionLimit({ ...lookup, member: { ...lookup.member, balance: -100 } }, 9800), 0);
});

test("use/skip decisions require an explicit link and preserve the server policy", () => {
  const use = membershipChoice(lookup, "USE", 100, 9800);
  assert.equal(use.pointsToUse, 100);
  assert.deepEqual(membershipDraftFields(use), { membershipAccountId: "member-1", pointUseDecision: "USE", pointsToUse: 100, pointPolicyVersion: lookup.policy.version });
  assert.deepEqual(membershipDraftFields(membershipChoice(lookup, "SKIP", 0, 9800)), {
    membershipAccountId: "member-1", pointUseDecision: "SKIP", pointsToUse: 0, pointPolicyVersion: lookup.policy.version,
  });
  assert.deepEqual(membershipDraftFields(null), {});
  for (const points of [-100, 0, 1, 99, 150, 2500, 100.5, NaN]) assert.throws(() => membershipChoice(lookup, "USE", points, 9800));
  assert.throws(() => membershipChoice(lookup, "SKIP", 100, 9800));
  for (const linkStatus of ["UNLINKED", "MISMATCH"] as const) {
    assert.throws(() => membershipChoice({ ...lookup, linkStatus }, "USE", 100, 9800), /連携/);
    assert.throws(() => membershipChoice({ ...lookup, linkStatus }, "SKIP", 0, 9800), /連携/);
  }
});

test("point amount input automatically maps zero and multiples of 100 to the internal API decision", () => {
  assert.equal(membershipFromPointInput(lookup, "0", 9800).decision, "SKIP");
  assert.equal(membershipFromPointInput(lookup, "100", 9800).decision, "USE");
  assert.equal(membershipFromPointInput(lookup, "2400", 9800).pointsToUse, 2400);
  for (const input of ["", "-100", "99", "150", "2500", "100.5", "1e2"]) {
    assert.throws(() => membershipFromPointInput(lookup, input, 9800));
  }
  assert.equal(membershipFromPointInput(lookup, "0", 9800, false).decision, "SKIP");
  assert.throws(() => membershipFromPointInput(lookup, "100", 9800, false));
});

test("lookup defaults to zero and only restores a matching policy, valid amount and unpaid redemption", () => {
  assert.equal(membershipSelectionForLookup(lookup, null, 9800).value.pointsToUse, 0);
  const previous = membershipChoice(lookup, "USE", 100, 9800);
  assert.deepEqual(membershipSelectionForLookup(lookup, previous, 9800), { value: previous, reset: false });
  for (const saved of [{ ...previous, policyVersion: "old-policy" }, { ...previous, pointsToUse: 150 },
    { ...previous, pointsToUse: 2500 }, { ...previous, pointsToUse: 0 }, { ...previous, decision: "SKIP" as const }]) {
    const restored = membershipSelectionForLookup(lookup, saved, 9800);
    assert.equal(restored.value.decision, "SKIP"); assert.equal(restored.value.pointsToUse, 0); assert.equal(restored.reset, true);
    assert.equal(restored.value.policyVersion, lookup.policy.version);
  }
  assert.equal(membershipSelectionForLookup(lookup, previous, 99).value.pointsToUse, 0);
  assert.equal(membershipSelectionForLookup(lookup, previous, 9800, false).value.pointsToUse, 0);
  assert.equal(membershipSelectionForLookup(lookup, { ...previous, accountId: "another-member" }, 9800).value.pointsToUse, 0);
  assert.throws(() => membershipSelectionForLookup({ ...lookup, linkStatus: "UNLINKED" }, null, 9800), /連携/);
});

test("linked member form contains only an amount field with zero/100 steps, without a spoken question or choice buttons", () => {
  const html = renderToStaticMarkup(<MembershipPointsInput id="points-test" value="0" limit={2400} valid disabled={false} allowRedemption onChange={() => undefined} />);
  assert.match(html, /利用ポイント/); assert.match(html, /min="0" max="2400" step="100"/); assert.match(html, /value="0"/);
  assert.match(html, /読み取り・下書き保存では残高を減らしません/);
  assert.doesNotMatch(html, /ポイントを使いますか|今回は使わない|<button/);
  const prepaid = renderToStaticMarkup(<MembershipPointsInput id="prepaid-test" value="100" limit={2400} valid disabled={false} allowRedemption={false} onChange={() => undefined} />);
  assert.match(prepaid, /max="0" step="100"/); assert.match(prepaid, /value="0"/); assert.match(prepaid, /readOnly=""|readonly=""/);
  assert.match(prepaid, /入金済みのため、後からポイント値引きはできません/);
  assert.doesNotMatch(prepaid, /選んで|今回は使わない|<button/);
});

test("lookup sends the barcode in a private POST and surfaces unavailable configuration without sample fallback", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const mock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Response.json(lookup);
  });
  const url = "/api/salon-test/backend/membership/lookup";
  assert.deepEqual(await membershipRequest(url, { barcode: "1000000000001", checkoutId: "checkout-1" }), lookup);
  assert.equal(calls[0].url, url);
  assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.credentials, "same-origin"); assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { barcode: "1000000000001", checkoutId: "checkout-1" });
  mock.mock.mockImplementation(async () => Response.json({ message: "sensitive upstream diagnostics" }, { status: 503 }));
  await assert.rejects(membershipRequest(url, { barcode: "1000000000001" }), /接続設定が完了していません/);
  mock.mock.mockImplementation(async () => Response.json({}, { status: 404 }));
  await assert.rejects(membershipRequest(url, { barcode: "1000000000001" }), /入会状況/);
});

test("member details show common balance and scoped history, escaping customer supplied content", () => {
  const html = renderToStaticMarkup(<MembershipDetails lookup={{ ...lookup, member: { ...lookup.member, name: "<script>名前</script>" } }} />);
  assert.match(html, /現在の共通ポイント/); assert.match(html, /2,480 pt/);
  assert.match(html, /この店舗のポイント履歴/); assert.match(html, /\+490 pt/);
  assert.match(html, /&lt;script&gt;名前&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
});

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "test" };
const checkout: CashCheckout = {
  id: "checkout-1", reservationId: "reservation-1", status: "DRAFT", version: 2,
  reservationSnapshot: { customerId: "customer-1", customerName: "予約のお客様", serviceName: "テスト施術", staffName: "担当テスト", salonName: "テスト店舗", startsAt: "2026-10-29T04:00:00Z" },
  items: [{ label: "テスト施術", quantity: 1, unitPriceYen: 5500, discountYen: 500, taxRate: 10 }],
  payments: [{ method: "CASH", amountYen: 4900, reference: "" }], legacyPaymentStatus: "UNPAID", legacyPaidAcknowledged: false,
  subtotalYen: 5500, discountYen: 500, pointsDiscountYen: 100, totalYen: 4900, cashYen: 4900, taxYen: 445,
  taxBreakdown: [{ taxRate: 10, taxableTotalYen: 4900, taxYen: 445 }], notes: "", finalizedAt: null, reversedAt: null, reversalReason: null,
};
function renderCheckout(value: CashCheckout, permissions = ["checkout.read", "checkout.write", "register.read"]): string {
  return renderToStaticMarkup(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/salon-test/checkout/checkout-1"><SearchParamsContext.Provider value={new URLSearchParams()}>
    <TenantProvider tenantSlug="salon-test" activeSalonId="salon-test" memberships={[{ role: "STAFF", permissions, tenant: { id: "tenant-test", slug: "salon-test", name: "テスト店舗", salons: [{ id: "salon-test", name: "テスト店舗" }] } }]}>
      <CashCheckoutEditor initialCheckout={value} registers={[{ id: "register-test", businessDate: "2026-10-29", status: "OPEN", openingCashYen: 0, expectedCashYen: 0, differenceYen: null }]} />
    </TenantProvider></SearchParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider>);
}
const selected: CashMembership = membershipChoice(lookup, "USE", 100, 5000);

test("saved membership drives the point discount and replaces the manual legacy input", () => {
  const html = renderCheckout({ ...checkout, membership: selected });
  assert.match(html, /会員証・ポイント確認/); assert.match(html, /会員確認のお客様/); assert.match(html, /会員番号 1000000000001/);
  assert.match(html, /利用ポイント 100 pt（100円）/); assert.match(html, /100ポイント利用 \/ ￥100値引き/);
  assert.doesNotMatch(html, /ポイント利用額（円）/); assert.doesNotMatch(html, /会員アプリのポイント残高は別途更新/);
  assert.match(html, /会計金額（値引後）<\/span><strong>￥4,900<\/strong>/);
});

test("invalid saved units and late redemption on prepaid reservations block finalization", () => {
  for (const value of [{ ...checkout, membership: { ...selected, pointsToUse: 50 }, pointsDiscountYen: 50 },
    { ...checkout, membership: selected, legacyPaymentStatus: "PAID" }]) {
    const html = renderCheckout(value);
    assert.match(html, /<button class="primaryButton" disabled="" type="button">会計を確定<\/button>/);
    assert.match(html, /<button class="primaryButton" disabled="">下書きを保存<\/button>/);
  }
});

test("zero use remains visible as an amount and readonly views expose no point editing action", () => {
  const skip = membershipChoice(lookup, "SKIP", 0, 5000);
  const html = renderCheckout({ ...checkout, membership: skip, pointsDiscountYen: 0, payments: [{ method: "CASH", amountYen: 5000, reference: "" }] });
  assert.match(html, /利用ポイント 0 pt（0円）/); assert.match(html, /0ポイント利用 \/ ￥0値引き/);
  assert.doesNotMatch(html, /ポイントを使いますか|今回は使わない|>使う</);
  assert.match(html, /会計金額（値引後）<\/span><strong>￥5,000<\/strong>/);
  for (const view of [renderCheckout({ ...checkout, membership: selected }, ["checkout.read"]), renderCheckout({ ...checkout, membership: selected, status: "FINALIZED" })]) {
    assert.match(view, /利用ポイント 100 pt（100円）/);
    assert.doesNotMatch(view, /会員証を読み取る/); assert.doesNotMatch(view, />下書きを保存<|>会計を確定</);
  }
});
