import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AdminSidebar } from "../src/components/admin-shell";
import { CustomerManagement } from "../src/components/customer-management";
import { ReservationDashboard } from "../src/components/reservation-dashboard";
import { TenantProvider, type TenantMembership } from "../src/components/tenant-provider";
import { firstAccessibleAdminPath } from "../src/lib/admin-navigation";

const router: AppRouterInstance = {
  back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "test"
};

function renderFor(permissions: string[], children: ReactNode, role: TenantMembership["role"] = "STAFF") {
  const memberships: TenantMembership[] = [{
    role,
    permissions,
    tenant: { id: "tenant-test", slug: "salon-test", name: "テスト店舗", salons: [{ id: "salon-test", name: "テスト店舗" }] }
  }];
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/salon-test">
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <TenantProvider tenantSlug="salon-test" memberships={memberships}>
            {children}
          </TenantProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

test("初期画面は閲覧可能なモジュールへ進み、無権限では予約表を選ばない", () => {
  assert.equal(firstAccessibleAdminPath({ role: "OWNER", permissions: [] }), "/");
  assert.equal(firstAccessibleAdminPath({ permissions: ["reservation.read", "checkout.read"] }), "/");
  assert.equal(firstAccessibleAdminPath({ permissions: ["checkout.read"] }), "/checkout");
  assert.equal(firstAccessibleAdminPath({ permissions: ["chart.read"] }), "/charts");
  assert.equal(firstAccessibleAdminPath({ permissions: ["customer.read"] }), "/customers");
  assert.equal(firstAccessibleAdminPath({ permissions: ["audit.read"] }), "/access/audit");
  assert.equal(firstAccessibleAdminPath({ permissions: [] }), null);
  assert.equal(firstAccessibleAdminPath({ permissions: ["unknown.read"] }), null);
});

test("共通メニューは権限のある機能だけを表示する", () => {
  const html = renderFor(["checkout.read", "chart.read"], <AdminSidebar active="/checkout" />);
  assert.match(html, /href="\/salon-test\/checkout"/);
  assert.match(html, /href="\/salon-test\/charts"/);
  assert.doesNotMatch(html, />予約表</);
  assert.doesNotMatch(html, /href="\/salon-test\/customers"/);
  assert.doesNotMatch(html, /href="\/salon-test\/access"/);
  assert.match(html, /ログアウト/);

  const owner = renderFor([], <AdminSidebar active="/" />, "OWNER");
  for (const path of ["checkout", "register", "charts", "access", "access/audit"]) {
    assert.ok(owner.includes(`href="/salon-test/${path}"`), `${path} appears for the owner`);
  }
});

test("予約表は閲覧権限だけの場合に新規登録の導線を表示しない", () => {
  const readOnly = renderFor(["reservation.read"], <ReservationDashboard />);
  assert.doesNotMatch(readOnly, /href="\/salon-test\/reservations\/new"/);
  assert.doesNotMatch(readOnly, /空き枠をクリック／ドラッグして予約登録/);
  const writable = renderFor(["reservation.read", "reservation.write"], <ReservationDashboard />);
  assert.match(writable, /href="\/salon-test\/reservations\/new"/);
});

test("顧客一覧は登録権限を持つ場合だけ新規登録の導線を表示する", () => {
  const readOnly = renderFor(["customer.read"], <CustomerManagement initialCustomers={[]} />);
  assert.doesNotMatch(readOnly, /href="\/salon-test\/customers\/new"/);
  const writable = renderFor(["customer.read", "customer.write"], <CustomerManagement initialCustomers={[]} />);
  assert.match(writable, /href="\/salon-test\/customers\/new"/);
});
