import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsManagement } from "../src/components/settings-management";
import { TenantProvider } from "../src/components/tenant-provider";
import type { AdminSettingsPayload } from "../src/lib/admin-types";

const data: AdminSettingsPayload = {
  salon: { id: "salon-test", name: "表示用店舗名", timezone: "Asia/Tokyo" },
  settings: { storeId: "store-test", openTime: "09:00", closeTime: "20:00", closedDays: [], maxConcurrentReservations: 7, bookingWindowValue: "1ヶ月先", reservationCutoffMode: "previous_day", reservationCutoffDays: 1, reservationCutoffTime: "21:30", cancellationCutoffMode: "previous_day", cancellationCutoffDays: 1, cancellationCutoffTime: "21:30", multiMenuBooking: true, autoAssignUnspecified: true, lineThemeColor: "#ff0000", categoryDisplayMode: "collapsed", candidateIntervalMinutes: 30, calendarDefaultView: "week", calendarDisplayMode: "collapsed", notificationEmail: "admin@example.test", receiptIssuerName: "正式事業者<script>名称</script>", invoiceRegistrationNumber: "T1234567890123", notifyReservationEmail: true, notifyReservationLine: false, notifyCancellation: true, notifyCancellationEmail: true, notifyCancellationLine: false, cancellationMessage: "受付", friendMessage: "登録", preReservationMessage: "案内", questionsEnabled: false, paymentEnabled: false, acceptingReservations: true }
};
function render(permissions: string[], initialData = data) {
  return renderToStaticMarkup(createElement(TenantProvider, {
    tenantSlug: "salon-test", memberships: [{ role: "STAFF", permissions, tenant: { id: "tenant-test", slug: "salon-test", name: "店舗", salons: [{ id: "salon-test", name: "店舗" }] } }],
    children: createElement(SettingsManagement, { initialData })
  }));
}

test("store settings expose separate formal issuer and registration number fields with NTA verification guidance", () => {
  const html = render(["settings.read", "settings.write"]);
  assert.match(html, /領収書の発行者情報/); assert.match(html, /正式事業者名/);
  assert.match(html, /maxLength="300"[^>]*value="正式事業者&lt;script&gt;名称&lt;\/script&gt;"/);
  assert.match(html, /pattern="\[Tt\]\[0-9\]\{13\}"[^>]*value="T1234567890123"/);
  assert.match(html, /href="https:\/\/www.invoice-kohyo.nta.go.jp\/"/);
  assert.match(html, /正式事業者名と登録の有効性を確認/);
  assert.match(html, /設定を保存/); assert.doesNotMatch(html, /<script>/);
  assert.equal(data.settings?.notificationEmail, "admin@example.test");
  assert.equal(data.salon?.name, "表示用店舗名");
});

test("existing null issuer settings remain blank and viewing permissions cannot edit them", () => {
  const html = render(["settings.read"], { ...data, settings: { ...data.settings!, receiptIssuerName: null, invoiceRegistrationNumber: null } });
  assert.match(html, /aria-describedby="receipt-issuer-name-help"[^>]*readOnly=""[^>]*value=""/);
  assert.match(html, /aria-describedby="invoice-registration-number-help"[^>]*readOnly=""[^>]*value=""/);
  assert.doesNotMatch(html, /設定を保存|T1234567890123|正式事業者&lt;script/);
});
