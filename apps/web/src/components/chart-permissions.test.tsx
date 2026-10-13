import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartCreateLink } from "./chart-actions";
import { ChartDetail } from "./chart-detail";
import { ChartList } from "./chart-list";
import { ChartNewForm } from "./chart-new-form";
import { TenantProvider, type TenantMembership } from "./tenant-provider";
import type { ChartDetail as ChartDetailData, ChartStatus } from "./chart-types";

function chart(status: ChartStatus = "DRAFT"): ChartDetailData {
  const when = "2026-10-13T00:15:00.000Z";
  return {
    id: "chart-one", reservationId: "reservation-one", customerId: "customer-one", customerName: "顧客A",
    staffId: null, staffName: null, serviceName: "施術A", startsAt: when, endsAt: when,
    treatmentAt: when, currentRevisionNumber: 1, version: 1, status, updatedAt: when,
    photoCount: 1, timezone: "Asia/Tokyo",
    reservation: { id: "reservation-one", startsAt: when, endsAt: when, status: "CONFIRMED", customer: { id: "customer-one", name: "顧客A" }, staff: null, service: { id: "service-one", name: "施術A" } },
    revisions: [{ id: "revision-one", revisionNumber: 1, status, treatmentAt: when,
      bodyParts: ["顔"], performedServiceDetail: "記録した施術の詳細", machine: "機器A", outputJ: "8 J", pulseWidth: "10 ms",
      skinObservations: "記録した肌の状態", productsMaterials: "製品A", aftercareNotes: "説明内容", nextVisitPlan: "次回予定",
      amendmentReason: null, createdAt: when, updatedAt: when, finalizedAt: status === "FINALIZED" ? when : null,
      createdByName: "スタッフA", finalizedByName: status === "FINALIZED" ? "スタッフA" : null,
      photos: [{ id: "photo-one", phase: "BEFORE", mimeType: "image/jpeg", width: 100, height: 100, byteSize: 1024, createdAt: when }]
    }]
  };
}

function render(children: ReactNode, permissions?: string[], role?: TenantMembership["role"]) {
  return renderToStaticMarkup(createElement(TenantProvider, {
    tenantSlug: "tenant-one", memberships: [{ role, permissions, tenant: { id: "tenant-id", slug: "tenant-one", name: "店舗グループ", salons: [{ id: "salon-one", name: "店舗A" }] } }],
    children
  }));
}

test("カルテ閲覧だけの利用者には下書き本文・写真を表示し更新操作を表示しない", () => {
  const html = render(createElement(ChartDetail, { initialChart: chart() }), ["chart.read"], "VIEWER");
  assert.match(html, /記録した施術の詳細/);
  assert.match(html, /記録した肌の状態/);
  assert.match(html, /src="\/api\/tenant-one\/backend\/charts\/chart-one\/photos\/photo-one"/);
  assert.match(html, /この顧客のカルテ履歴/);
  assert.doesNotMatch(html, /<form|<textarea|<input|下書きを保存|カルテを確定|記録写真を追加|削除|\/customers\/customer-one\/edit|\/reservations\/reservation-one\/edit/);
});

test("閲覧だけの確定済みカルテには訂正フォームを表示しない", () => {
  const html = render(createElement(ChartDetail, { initialChart: chart("FINALIZED") }), ["chart.read"], "VIEWER");
  assert.match(html, /記録した施術の詳細/);
  assert.doesNotMatch(html, /カルテを訂正|訂正用の下書きを作成|<textarea|<form/);
});

test("カルテ書込権限で下書き操作は表示するが顧客・予約の編集導線は別権限にする", () => {
  const html = render(createElement(ChartDetail, { initialChart: chart() }), ["chart.read", "chart.write"], "STAFF");
  assert.match(html, /下書きを保存/);
  assert.match(html, /カルテを確定/);
  assert.match(html, /記録写真を追加/);
  assert.match(html, /削除/);
  assert.doesNotMatch(html, /\/customers\/customer-one\/edit|\/reservations\/reservation-one\/edit/);
  const allowed = render(createElement(ChartDetail, { initialChart: chart() }), ["chart.read", "chart.write", "customer.write", "reservation.write"], "STAFF");
  assert.match(allowed, /\/customers\/customer-one\/edit/);
  assert.match(allowed, /\/reservations\/reservation-one\/edit/);
});

test("確定済みカルテの訂正は書込権限がある場合だけ表示する", () => {
  const html = render(createElement(ChartDetail, { initialChart: chart("FINALIZED") }), ["chart.read", "chart.write"], "STAFF");
  assert.match(html, /訂正用の下書きを作成/);
  assert.doesNotMatch(html, /記録写真を追加|下書きを保存/);
});

test("作成CTAと新規画面への直接アクセスをカルテ書込権限で制御する", () => {
  assert.equal(render(createElement(ChartCreateLink), ["chart.read"], "VIEWER"), "");
  assert.match(render(createElement(ChartCreateLink, { reservationId: "reservation-one" }), ["chart.write"], "STAFF"), /\/charts\/new\?reservationId=reservation-one/);
  const denied = render(createElement(ChartNewForm), ["chart.read"], "VIEWER");
  assert.match(denied, /カルテを作成する権限がありません/);
  assert.doesNotMatch(denied, /<form|<input|下書きとして保存|予約を選択/);
});

test("一覧の顧客・予約編集リンクも対応権限に限定する", () => {
  const node = createElement(ChartList, { initialCharts: [chart()], initialCursor: null, customerId: "customer-one", reservationId: "reservation-one" });
  const readonly = render(node, ["chart.read"], "VIEWER");
  assert.match(readonly, /顧客A/);
  assert.match(readonly, /\/charts\/chart-one/);
  assert.doesNotMatch(readonly, /\/customers\/customer-one\/edit|\/reservations\/reservation-one\/edit/);
  const allowed = render(node, ["chart.read", "customer.write", "reservation.write"], "STAFF");
  assert.match(allowed, /\/customers\/customer-one\/edit/);
  assert.match(allowed, /\/reservations\/reservation-one\/edit/);
});

test("権限情報が未取得の初期状態は安全な閲覧表示とし、役割名から書込を推定しない", () => {
  const html = render(createElement(ChartDetail, { initialChart: chart() }), undefined, "STAFF");
  assert.match(html, /記録した施術の詳細/);
  assert.doesNotMatch(html, /<textarea|<form|下書きを保存|記録写真を追加/);
  assert.equal(render(createElement(ChartCreateLink)), "");
  assert.match(render(createElement(ChartNewForm)), /カルテを作成する権限がありません/);
});


test("閲覧権限で写真の部位・撮影日時・観察内容を安全に表示し、アップロード入力を許可しない", () => {
  const data = chart();
  Object.assign(data.revisions[0].photos[0], { bodyPart: "右ひざ下", note: "毛量が減少\n<script>赤みなし</script>", capturedAt: "2026-10-12T23:05:00.000Z" });
  const html = render(createElement(ChartDetail, { initialChart: data }), ["chart.read"], "VIEWER");
  assert.match(html, /右ひざ下/);
  assert.match(html, /2026\/10\/13 08:05/);
  assert.match(html, /毛量が減少/);
  assert.match(html, /&lt;script&gt;赤みなし&lt;\/script&gt;/);
  assert.match(html, /写真を拡大/);
  assert.doesNotMatch(html, /<input|<textarea|写真を保存|記録写真を追加|<script>/);
});

test("写真の記録欄は下書きの書込権限に限定し、写真を選んで保存できる", () => {
  const html = render(createElement(ChartDetail, { initialChart: chart() }), ["chart.read", "chart.write"], "STAFF");
  assert.match(html, /撮影部位（任意）/);
  assert.match(html, /撮影日時（日本時間・任意）/);
  assert.match(html, /脱毛の状態・気づいた点（任意）/);
  assert.match(html, /写真を保存/);
  const finalized = render(createElement(ChartDetail, { initialChart: chart("FINALIZED") }), ["chart.read", "chart.write"], "STAFF");
  assert.doesNotMatch(finalized, /撮影部位（任意）|写真を保存|記録写真を追加/);
});
