import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { CashCheckoutEditor } from "../src/components/cash-views";
import type { CashCheckout } from "../src/components/cash-types";
import { TenantProvider } from "../src/components/tenant-provider";

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "test" };
const checkout: CashCheckout = {
  id: "checkout-points", reservationId: "reservation-points", status: "DRAFT", version: 2,
  reservationSnapshot: { customerName: "通知確認のお客様", serviceName: "テスト施術", staffName: "担当テスト", salonName: "テスト店", startsAt: "2026-10-30T04:00:00Z" },
  items: [{ label: "テスト施術", quantity: 1, unitPriceYen: 5500, discountYen: 500, taxRate: 10, pointsDiscountYen: 300, totalYen: 4700 }],
  payments: [{ method: "CASH", amountYen: 4700, reference: "" }],
  legacyPaymentStatus: "UNPAID", legacyPaidAcknowledged: false,
  subtotalYen: 5500, discountYen: 500, pointsDiscountYen: 300, totalYen: 4700, cashYen: 4700, taxYen: 427,
  taxBreakdown: [{ taxRate: 10, taxableTotalYen: 4700, taxYen: 427 }], notes: "", finalizedAt: null, reversedAt: null, reversalReason: null
};
function render(value = checkout, writable = true) {
  return renderToStaticMarkup(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/salon-test/checkout/checkout-points"><SearchParamsContext.Provider value={new URLSearchParams()}>
    <TenantProvider tenantSlug="salon-test" memberships={[{ role: "STAFF", permissions: ["checkout.read", "register.read", ...(writable ? ["checkout.write"] : [])], tenant: { id: "tenant-test", slug: "salon-test", name: "テスト店", salons: [{ id: "salon-test", name: "テスト店" }] } }]}>
      <CashCheckoutEditor initialCheckout={value} registers={[{ id: "register-test", businessDate: "2026-10-23", status: "OPEN", openingCashYen: 0, expectedCashYen: 0, differenceYen: null }]} />
    </TenantProvider></SearchParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider>);
}

test("saved point discounts reduce the shown amount and retain distinct discount labels", () => {
  const html = render();
  assert.match(html, /ポイント利用額（円）/);
  assert.match(html, /max="5000" step="1"[^>]*value="300"/);
  assert.match(html, /<dt>通常値引<\/dt><dd>￥500<\/dd>/);
  assert.match(html, /<dt>ポイント値引<\/dt><dd>￥300<\/dd>/);
  assert.match(html, /会計金額（値引後）<\/span><strong>￥4,700<\/strong>/);
  assert.match(html, /差額<\/span><strong class="">￥0<\/strong>/);
  assert.match(html, /<button class="primaryButton" type="button">会計を確定<\/button>/);
  assert.match(html, /会員アプリのポイント残高は別途更新してください/);
});

test("excess points block finalization and a fully discounted amount needs no payment", () => {
  const invalid = render({ ...checkout, pointsDiscountYen: 5001 });
  assert.match(invalid, /aria-invalid="true"/);
  assert.match(invalid, /role="alert"/);
  assert.match(invalid, /<button class="primaryButton" disabled="" type="button">会計を確定<\/button>/);
  const free = render({ ...checkout, pointsDiscountYen: 5000, payments: [], totalYen: 0, cashYen: 0 });
  assert.match(free, /会計金額（値引後）<\/span><strong>￥0<\/strong>/);
  assert.match(free, /<button class="primaryButton" type="button">会計を確定<\/button>/);
});

test("legacy checkouts default points to zero; read-only and finalized views cannot edit", () => {
  const legacy = { ...checkout, pointsDiscountYen: undefined, totalYen: 5000, payments: [{ method: "CASH" as const, amountYen: 5000, reference: "" }] };
  assert.match(render(legacy), /<dt>ポイント値引<\/dt><dd>￥0<\/dd>/);
  for (const html of [render(checkout, false), render({ ...checkout, status: "FINALIZED" })]) {
    assert.match(html, /<fieldset disabled=""/);
    assert.doesNotMatch(html, />下書きを保存<|>会計を確定</);
    assert.match(html, /会計金額（値引後）<\/span><strong>￥4,700<\/strong>/);
  }
});
