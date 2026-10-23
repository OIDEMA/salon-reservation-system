import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ReservationDashboard } from "../src/components/reservation-dashboard";
import { TenantProvider } from "../src/components/tenant-provider";
import { dashboardPreloadState, dashboardToday, isDashboardDocumentRequest, matchingDashboardPreload, takeDashboardPreload, validDashboardDate, type DashboardPreload, type DashboardRequest } from "../src/lib/dashboard-preload";
import { createEmptyDashboard, type ScheduleReservation } from "../src/lib/types";

const request: DashboardRequest = { tenantSlug: "test-tenant", salonId: "salon-test", date: "2026-10-23", q: "", status: "ALL", refreshKey: 0, canRead: true };
const reservation: ScheduleReservation = {
  id: "reservation-test", rowId: "unassigned", serviceId: "menu-test", startTime: "10:00", endTime: "10:30",
  customerName: "先行表示テスト顧客", customerKana: "テスト", serviceName: "テスト施術", category: "脱毛", price: 1000,
  status: "CONFIRMED", source: "WEB", isRequest: false, riskScore: 0, lineStatus: "NOT_SENT", paymentStatus: "UNPAID", memo: "", visitCount: 0, tags: []
};
const initialData: DashboardPreload = { tenantSlug: request.tenantSlug, data: {
  ...createEmptyDashboard(request.date), salon: { id: request.salonId!, name: "テスト店舗", timezone: "Asia/Tokyo" },
  rows: [{ id: "unassigned", type: "unassigned", label: "指名なし", subtitle: "", color: "#334155", count: 1 }], reservations: [reservation]
} };

test("dashboard dates reject impossible dates and use the Japan day at the UTC boundary", () => {
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "2026-10-23T00:00:00Z", "", null, undefined]) assert.equal(validDashboardDate(date), null);
  assert.equal(validDashboardDate("2024-02-29"), "2024-02-29");
  assert.equal(validDashboardDate("2026-10-23"), "2026-10-23");
  assert.equal(dashboardToday(new Date("2026-10-22T14:59:59Z")), "2026-10-22");
  assert.equal(dashboardToday(new Date("2026-10-22T15:00:00Z")), "2026-10-23");
});

test("only HTML documents preload data; RSC fetches keep their single fresh client request", () => {
  assert.equal(isDashboardDocumentRequest(new Headers({ accept: "text/html,application/xhtml+xml" })), true);
  assert.equal(isDashboardDocumentRequest(new Headers({ "sec-fetch-dest": "document" })), true);
  assert.equal(isDashboardDocumentRequest(new Headers({ accept: "*/*", rsc: "1", "sec-fetch-dest": "empty" })), false);
  assert.equal(isDashboardDocumentRequest(new Headers({ accept: "text/x-component", rsc: "1" })), false);
  assert.equal(isDashboardDocumentRequest(new Headers()), false);
});

test("the initial response is usable only for the exact tenant, salon, date, filters and permission", () => {
  assert.equal(matchingDashboardPreload(initialData, request), initialData.data);
  const changes: Partial<DashboardRequest>[] = [
    { tenantSlug: "different-tenant" }, { salonId: "different-salon" }, { salonId: undefined }, { date: "2026-10-24" },
    { q: "テスト" }, { status: "CONFIRMED" }, { refreshKey: 1 }, { canRead: false }
  ];
  for (const change of changes) assert.equal(matchingDashboardPreload(initialData, { ...request, ...change }), undefined, JSON.stringify(change));
  assert.equal(matchingDashboardPreload(undefined, request), undefined);
});

test("repeated mount effects use initial data without starting a duplicate request", () => {
  const state = dashboardPreloadState(initialData, request);
  assert.equal(takeDashboardPreload(state, initialData, request), initialData.data);
  assert.equal(takeDashboardPreload(state, initialData, { ...request }), initialData.data);
});

test("date, search, status, refresh, salon and permission changes invalidate the old response even after reverting", () => {
  const changes: Partial<DashboardRequest>[] = [
    { date: "2026-10-24" }, { q: "テスト" }, { status: "PENDING" }, { refreshKey: 1 },
    { salonId: "different-salon" }, { tenantSlug: "different-tenant" }, { canRead: false }
  ];
  for (const change of changes) {
    const state = dashboardPreloadState(initialData, request);
    assert.equal(takeDashboardPreload(state, initialData, request), initialData.data);
    assert.equal(takeDashboardPreload(state, initialData, { ...request, ...change }), undefined);
    assert.equal(takeDashboardPreload(state, initialData, request), undefined, JSON.stringify(change));
  }
});

test("same-day server refreshes and cached RSC props always request fresh data", () => {
  const next: DashboardPreload = { ...initialData, data: { ...initialData.data, reservations: [] } };
  const state = dashboardPreloadState(initialData, request);
  assert.equal(takeDashboardPreload(state, next, request), undefined);
  assert.equal(takeDashboardPreload(state, initialData, request), undefined);
  const refreshState = dashboardPreloadState(initialData, { ...request, renderId: "first-render" });
  assert.equal(takeDashboardPreload(refreshState, initialData, { ...request, renderId: "refreshed-render" }), undefined);
  for (const change of [{ q: "テスト" }, { status: "PENDING" as const }, { refreshKey: 1 }]) {
    const changed = { ...request, ...change };
    const filteredState = dashboardPreloadState(initialData, changed);
    assert.equal(takeDashboardPreload(filteredState, next, changed), undefined);
  }
});

test("failed preloads and client-only mounts always use the client request", () => {
  const state = dashboardPreloadState(undefined, request);
  assert.equal(takeDashboardPreload(state, undefined, request), undefined);
  assert.equal(takeDashboardPreload(state, initialData, request), undefined);
  assert.equal(takeDashboardPreload(state, undefined, request), undefined);
  const clientMount = dashboardPreloadState(initialData, request, false);
  assert.equal(takeDashboardPreload(clientMount, initialData, request), undefined);
  assert.equal(takeDashboardPreload(clientMount, { ...initialData }, request), undefined);
});

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "test" };
function render(preload: DashboardPreload | undefined, permissions = ["reservation.read"], date = request.date) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/test-tenant">
        <SearchParamsContext.Provider value={new URLSearchParams({ date })}>
          <TenantProvider tenantSlug={request.tenantSlug} memberships={[{ role: "STAFF", permissions,
            tenant: { id: "tenant-test", slug: request.tenantSlug, name: "テスト店舗", salons: [{ id: request.salonId!, name: "テスト店舗" }] } }]}>
            <ReservationDashboard initialData={preload} />
          </TenantProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

test("reservation cards are present in the first HTML response before client effects", () => {
  const html = render(initialData);
  assert.match(html, /先行表示テスト顧客/);
  assert.match(html, /data-reservation-card="true"/);
  assert.match(html, /テスト施術/);
  assert.doesNotMatch(html, /予約データを取得できませんでした|店舗情報が未登録/);
  assert.doesNotMatch(html, /reservationResizeHandle/);
  const noPreload = render(undefined);
  assert.doesNotMatch(noPreload, /先行表示テスト顧客|data-reservation-card/);
});

test("unreadable, cross-tenant, cross-salon and different-day data never appear in initial HTML", () => {
  assert.doesNotMatch(render(initialData, []), /先行表示テスト顧客|テスト施術/);
  assert.match(render(initialData, []), /予約表を閲覧する権限がありません/);
  assert.doesNotMatch(render({ ...initialData, tenantSlug: "different-tenant" }), /先行表示テスト顧客/);
  assert.doesNotMatch(render({ ...initialData, data: { ...initialData.data, salon: { ...initialData.data.salon!, id: "different-salon" } } }), /先行表示テスト顧客/);
  assert.doesNotMatch(render(initialData, undefined, "2026-10-24"), /先行表示テスト顧客/);
});
