import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AdminSidebar } from "../src/components/admin-shell";
import { CustomerManagement } from "../src/components/customer-management";
import { ReservationManagement } from "../src/components/reservation-management";
import { CashCheckoutList, CashCheckoutCreate } from "../src/components/cash-views";
import { ReservationDashboard } from "../src/components/reservation-dashboard";
import { ReservationCreateForm } from "../src/components/reservation-create-form";
import { ReservationEditForm } from "../src/components/reservation-edit-form";
import { ReservationStaffTools } from "../src/components/reservation-staff-tools";
import { TimelineReservationEditor } from "../src/components/timeline-reservation-editor";
import { ReservationCustomerFields } from "../src/components/reservation-customer-fields";
import { TenantProvider, type TenantMembership } from "../src/components/tenant-provider";
import { firstAccessibleAdminPath } from "../src/lib/admin-navigation";
import type { AdminMenu, AdminReservation, AdminStaff } from "../src/lib/admin-types";

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
  const readOnly = renderFor(["customer.read"], <CustomerManagement initialPage={{ customers: [], total: 0, page: 1, pageSize: 50, totalPages: 1 }} />);
  assert.doesNotMatch(readOnly, /href="\/salon-test\/customers\/new"/);
  const writable = renderFor(["customer.read", "customer.write"], <CustomerManagement initialPage={{ customers: [], total: 0, page: 1, pageSize: 50, totalPages: 1 }} />);
  assert.match(writable, /href="\/salon-test\/customers\/new"/);
});

test("顧客一覧のページ操作は全体件数を表示し、先頭・末尾の移動を制限する", () => {
  const first = renderFor(["customer.read"], <CustomerManagement initialPage={{ customers: [], total: 1050, page: 1, pageSize: 50, totalPages: 21 }} />);
  assert.match(first, /1,050件 \/ 1 \/ 21ページ/);
  assert.match(first, /<button[^>]*disabled=""[^>]*>前へ<\/button>/);
  assert.match(first, /<button class="secondaryButton" type="button">次へ<\/button>/);
  assert.doesNotMatch(first, /氏名・カナ・電話・タグ・メモで検索/);
  const last = renderFor(["customer.read", "chart.read"], <CustomerManagement initialPage={{ customers: [], total: 1050, page: 21, pageSize: 50, totalPages: 21 }} />);
  assert.match(last, /<button[^>]*disabled=""[^>]*>次へ<\/button>/);
  assert.match(last, /氏名・カナ・電話・タグ・メモで検索/);
});

test("予約・会計一覧はページ情報を表示し、会計の予約全件フォームを埋め込まない", () => {
  const reservation = renderFor(["reservation.read"], <ReservationManagement initialPage={{ reservations: [], total: 1005, page: 1, pageSize: 50, totalPages: 21 }} initialDateFrom="2026-10-01" initialDateTo="2026-10-14" />);
  assert.match(reservation, /1,005件 \/ 1 \/ 21ページ/);
  assert.match(reservation, /<button[^>]*disabled=""[^>]*>前へ<\/button>/);
  assert.doesNotMatch(reservation, />編集</);
  const checkout = renderFor(["checkout.read"], <CashCheckoutList initialPage={{ checkouts: [], total: 220, page: 5, pageSize: 50, totalPages: 5 }} />);
  assert.match(checkout, /220件 \/ 5 \/ 5ページ/);
  assert.match(checkout, /<button[^>]*disabled=""[^>]*>次へ<\/button>/);
  assert.doesNotMatch(checkout, /予約から会計を開始/);
});

test("会計作成の予約検索は予約閲覧権限を持つ場合だけ表示する", () => {
  const lookup = renderFor(["checkout.write", "reservation.read"], <CashCheckoutCreate />);
  assert.match(lookup, /予約を検索/);
  assert.doesNotMatch(lookup, /placeholder="予約番号"/);
  const manual = renderFor(["checkout.write"], <CashCheckoutCreate initialReservationId="known-reservation" />);
  assert.doesNotMatch(manual, /予約を検索/);
  assert.match(manual, /placeholder="予約番号"/);
  assert.match(manual, /value="known-reservation"/);
  assert.equal(renderFor(["checkout.read"], <CashCheckoutCreate />), "");
});

const reservationMenu: AdminMenu = {
  id: "menu-test", name: "登録済み施術", category: "脱毛", description: "", imageUrl: null,
  durationMinutes: 30, price: 5000, color: "#111111", menuType: "通常メニュー",
  lineVisible: true, unlimitedBooking: false, active: true, sortOrder: 1
};

function reservationStaff(id: string, name: string, active: boolean, sortOrder: number): AdminStaff {
  return {
    id, name, kana: name, role: "ESTHETICIAN", color: "#18c7bd", imageUrl: null,
    nominationFee: 0, comment: null, allocationOrder: sortOrder, parallelCapacity: 1,
    active, sortOrder
  };
}

test("予約の担当候補は登録済みの有効スタッフを表示し、停止スタッフは新規選択に出さない", () => {
  const staff = [
    reservationStaff("staff-a", "予約担当A", true, 1),
    reservationStaff("staff-stopped", "停止担当", false, 2),
    reservationStaff("staff-b", "予約担当B", true, 3)
  ];
  const html = renderFor(["reservation.read", "reservation.write"], <ReservationCreateForm
    menus={[reservationMenu]} categories={[]} staff={staff} defaultDate="2026-10-20"
  />);
  assert.match(html, />予約担当A</);
  assert.match(html, />予約担当B</);
  assert.ok(html.indexOf("予約担当A") < html.indexOf("予約担当B"));
  assert.doesNotMatch(html, /停止担当/);
  assert.match(html, /担当未指定/);
  assert.doesNotMatch(html, /自動割当/);
});

test("担当未登録時のスタッフ管理導線はマスタの閲覧・登録権限に従う", () => {
  const noMaster = renderFor(["reservation.read"], <ReservationStaffTools empty />);
  assert.doesNotMatch(noMaster, /href="\/salon-test\/staff(?:\/new)?"/);

  const readMaster = renderFor(["reservation.read", "master.read"], <ReservationStaffTools empty />);
  assert.match(readMaster, /href="\/salon-test\/staff"/);
  assert.doesNotMatch(readMaster, /href="\/salon-test\/staff\/new"/);

  const writeMaster = renderFor(["reservation.read", "master.write"], <ReservationStaffTools empty />);
  assert.match(writeMaster, /href="\/salon-test\/staff\/new"/);
});

test("予約編集は停止した現在の担当を保持し、他の停止スタッフは選択に出さない", () => {
  const current = reservationStaff("staff-current", "現在の停止担当", false, 1);
  const otherStopped = reservationStaff("staff-other", "別の停止担当", false, 2);
  const active = reservationStaff("staff-active", "変更先の有効担当", true, 3);
  const reservation: AdminReservation & { durationMinutes: number } = {
    id: "reservation-test", updatedAt: "2026-10-19T00:00:00Z", date: "2026-10-20",
    startTime: "13:00", endTime: "13:30", durationMinutes: 30, status: "CONFIRMED",
    source: "PHONE", isRequest: true, memo: "", riskScore: 0, paymentStatus: "UNPAID",
    lineMessageStatus: "NOT_SENT", customer: { id: "customer-test", name: "テスト顧客", kana: "テスト",
      phone: null, visitCount: 0, tags: [] }, service: reservationMenu,
    staff: { id: current.id, name: current.name }
  };
  // The catalog returns active staff only, so the current stopped staff must be
  // kept from the reservation itself rather than disappearing from the select.
  const fallback = renderFor(["reservation.read", "reservation.write"], <ReservationEditForm
    initialReservation={reservation} menus={[reservationMenu]} staff={[active]}
  />);
  assert.match(fallback, /<option value="staff-current" selected="">現在の停止担当/);
  assert.match(fallback, />変更先の有効担当</);

  const fullCatalog = renderFor(["reservation.read", "reservation.write"], <ReservationEditForm
    initialReservation={reservation} menus={[reservationMenu]} staff={[current, otherStopped, active]}
  />);
  assert.match(fullCatalog, /<option value="staff-current" selected="">現在の停止担当/);
  assert.doesNotMatch(fullCatalog, /別の停止担当/);
});

test("予約の登録済み顧客検索は顧客の閲覧権限を持つ場合だけ表示する", () => {
  const fields = <ReservationCustomerFields value={{ name: "", kana: "", phone: "" }} onChange={() => {}} />;
  const blocked = renderFor(["reservation.read", "reservation.write"], fields);
  assert.doesNotMatch(blocked, /登録済みのお客様を検索/);
  assert.doesNotMatch(blocked, /readonly=""/i);
  assert.match(blocked, /顧客名/);
  assert.match(blocked, /カナ/);
  assert.match(blocked, /電話番号/);

  const permitted = renderFor(["reservation.read", "reservation.write", "customer.read"], fields);
  assert.match(permitted, /登録済みのお客様を検索/);
  assert.doesNotMatch(permitted, /readonly=""/i);
});

test("選択した登録済み顧客の情報は解除するまで読み取り専用にして顧客の取り違えを防ぐ", () => {
  const selected = renderFor(["reservation.read", "reservation.write", "customer.read"],
    <ReservationCustomerFields value={{ customerId: "customer-selected", name: "登録済み顧客", kana: "トウロクズミコキャク", phone: "090-1234-5678" }} onChange={() => {}} />);
  assert.equal((selected.match(/readonly=""/gi) ?? []).length, 3);
  assert.match(selected, /選択を解除/);
  assert.match(selected, /value="登録済み顧客"/);
  assert.match(selected, /value="トウロクズミコキャク"/);
  assert.match(selected, /value="090-1234-5678"/);
  assert.doesNotMatch(selected, /<input[^>]*disabled=""/);
});


test("予約表の登録モーダルも顧客の閲覧権限に従って共通の顧客検索を表示する", () => {
  const editor = <TimelineReservationEditor
    value={{ kind: "create", date: "2026-10-20", startTime: "13:00", durationMinutes: 30, rowId: "unassigned" }}
    menus={[reservationMenu]} rows={[]} onClose={() => {}} onSaved={() => {}}
  />;
  const permitted = renderFor(["reservation.read", "reservation.write", "customer.read"], editor);
  assert.match(permitted, /登録済みのお客様を検索/);
  assert.match(permitted, /電話番号/);
  assert.match(permitted, /<input[^>]*placeholder="顧客名"[^>]*autofocus=""/i);
  const blocked = renderFor(["reservation.read", "reservation.write"], editor);
  assert.doesNotMatch(blocked, /登録済みのお客様を検索|登録済み顧客の候補/);
});
