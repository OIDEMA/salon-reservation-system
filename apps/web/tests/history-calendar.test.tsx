import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoricalScheduleAgenda, HistoricalScheduleCard, historicalScheduleLabel } from "../src/components/historical-schedule";
import { ReservationHistoryStaffLink, ReservationHistoryStaffLinkLink, ReservationHistoryStaffLinkPreview } from "../src/components/reservation-history-staff-link";
import { TenantProvider } from "../src/components/tenant-provider";
import { TimelineReservationEditor } from "../src/components/timeline-reservation-editor";
import { buildScheduleLayout, scheduleCardKey, scheduleRowAcceptsNewReservation } from "../src/lib/schedule-layout";
import { fetchDashboard } from "../src/lib/api";
import { applyHistoryStaffLinks, canLinkHistoryStaff, prepareHistoryStaffLinks } from "../src/lib/history-staff-link";
import { createEmptyDashboard, type HistoricalScheduleReservation, type ScheduleReservation, type ScheduleRow } from "../src/lib/types";
import type { AdminMenu, ReservationHistoryStaffLinkPlan } from "../src/lib/admin-types";

function render(children: ReactNode, permissions: string[], tenantSlug = "missmrs-takamatsu") {
  return renderToStaticMarkup(createElement(TenantProvider, {
    tenantSlug, memberships: [{ role: "STAFF", permissions, tenant: { id: "tenant-test", slug: tenantSlug, name: "テスト店", salons: [{ id: "salon-test", name: "テスト店" }] } }], children
  }));
}
const rows: ScheduleRow[] = [
  { id: "active", type: "staff", label: "現在の担当", subtitle: "予約受付中", color: "#18c7bd", count: 1, active: true },
  { id: "legacy", type: "staff", label: "過去の担当", subtitle: "予約受付停止", color: "#475569", count: 3, active: false }
];
const history: HistoricalScheduleReservation = {
  id: "history/unsafe-id", externalReservationId: "source-history-id", rowId: "legacy", startsAt: "2025-10-14T10:00:00+09:00",
  endsAt: "2025-10-14T11:00:00+09:00", startTime: "10:00", endTime: "11:00", customerName: "移行した顧客",
  customerKana: null, staffName: "過去の担当", serviceName: "元の施術", reservationAmount: null,
  sourceStatus: "会計済み<script>元の状態</script>", source: "SALONBOARD", isRequest: true, readOnly: true
};
const operational: ScheduleReservation = {
  id: "operational", rowId: "active", serviceId: "menu", startTime: "10:00", endTime: "10:30", customerName: "現在の顧客",
  customerKana: "ゲンザイ", serviceName: "施術", category: "脱毛", price: 1000, status: "CONFIRMED", source: "WEB", isRequest: false,
  riskScore: 0, lineStatus: "NONE", paymentStatus: "UNPAID", memo: "", visitCount: 0, tags: []
};

test("履歴カードは原状態を安全に表示し、編集・ドラッグ・会計を持たず履歴詳細へリンクする", () => {
  assert.equal(render(createElement(HistoricalScheduleCard, { reservation: history, style: {} }), []), "");
  const html = render(createElement(HistoricalScheduleCard, { reservation: history, style: { left: 100 } }), ["reservation.read", "reservation.write", "checkout.write", "chart.write"]);
  assert.match(html, /^<a/);
  assert.match(html, /data-reservation-card="true"/);
  assert.match(html, /data-history-card="true"/);
  assert.match(html, /href="\/missmrs-takamatsu\/reservations\/history\/history%2Funsafe-id"/);
  assert.match(html, /会計済み&lt;script&gt;元の状態&lt;\/script&gt;/);
  assert.doesNotMatch(html, /data-resize-handle|<button|draggable|\/edit|\/checkout|<script>/);
  const missing = render(createElement(HistoricalScheduleCard, { reservation: { ...history, endsAt: null, endTime: null }, style: {} }), ["reservation.read"]);
  assert.match(missing, /終了時刻未登録/); assert.doesNotMatch(missing, /から11:00|10:00–11:00/);
  assert.match(historicalScheduleLabel(history), /移行した予約履歴を開く/);
});

test("一覧でもキャンセルを含む履歴全件が詳細リンクになり、原状態や担当を保持する", () => {
  const html = render(createElement(HistoricalScheduleAgenda, { reservations: [history, { ...history, id: "cancelled", sourceStatus: "サロンキャンセル" }] }), ["reservation.read", "reservation.write"]);
  assert.equal((html.match(/class="agendaItem historicalAgendaItem"/g) ?? []).length, 2);
  assert.match(html, /サロンキャンセル/); assert.match(html, /過去の担当/);
  assert.doesNotMatch(html, /<button|確定|編集|会計を開始/);
});

test("同じ担当と時間に完了・キャンセル・通常予約が重なっても別レーンに表示する", () => {
  const source = [history, { ...history, id: "cancelled", startTime: "10:00", endTime: "11:00", sourceStatus: "サロンキャンセル" },
    { ...history, id: "later", startTime: "11:10", endTime: "12:00" }];
  const layout = buildScheduleLayout(rows, [operational, { ...operational, id: "existing-legacy", rowId: "legacy" }], source, 9 * 60, 20 * 60);
  assert.equal(layout.rows[0].height, 76);
  assert.equal(layout.rows[1].top, 76); assert.equal(layout.rows[1].height, 228);
  const lanes = ["history:history/unsafe-id", "history:cancelled", "reservation:existing-legacy"].map((key) => layout.cards.get(key)?.lane);
  assert.equal(new Set(lanes).size, 3);
  assert.equal(layout.cards.get(scheduleCardKey("history", "later"))?.lane, 0);
  assert.equal(layout.cards.size, 5);
});

test("未登録の終了時間は表示幅だけ補い、深夜や営業時間外でも選択可能な位置に収める", () => {
  const missing = { ...history, id: "unknown-end", endTime: null, endsAt: null };
  const outside = { ...history, id: "outside", startTime: "22:00", endTime: "24:30" };
  const layout = buildScheduleLayout(rows, [], [missing, outside], 9 * 60, 20 * 60);
  for (const card of layout.cards.values()) {
    assert.ok(card.left >= 0); assert.ok(card.width > 0); assert.ok(card.left + card.width <= 11 * 132 + .0001);
  }
  assert.equal(missing.endTime, null); assert.equal(missing.endsAt, null);
  assert.equal(scheduleRowAcceptsNewReservation(rows[1]), false);
  assert.equal(scheduleRowAcceptsNewReservation(rows[0]), true);
  assert.equal(scheduleRowAcceptsNewReservation(undefined), false);
});

const menu: AdminMenu = { id: "menu", name: "施術", category: "脱毛", description: "", imageUrl: null, durationMinutes: 30,
  price: 1000, color: "#18c7bd", menuType: "通常", lineVisible: true, unlimitedBooking: false, active: true, sortOrder: 1 };
test("タイムライン登録の担当候補から履歴用の停止スタッフを除外し、既存担当のみ編集時に保持する", () => {
  const create = render(createElement(TimelineReservationEditor, { value: { kind: "create", date: "2026-10-15", startTime: "10:00", durationMinutes: 30, rowId: "active" }, menus: [menu], rows, onClose() {}, onSaved() {} }), ["reservation.write"]);
  assert.match(create, /現在の担当/); assert.doesNotMatch(create, /過去の担当/);
  const edit = render(createElement(TimelineReservationEditor, { value: { kind: "edit", date: "2026-10-15", startTime: "10:00", durationMinutes: 30, rowId: "legacy", reservation: { ...operational, rowId: "legacy" } }, menus: [menu], rows, onClose() {}, onSaved() {} }), ["reservation.write"]);
  assert.match(edit, /過去の担当/);
});

test("予約表の日付・検索・状態はAPIに送り、通常予約と履歴の別配列をそのまま受け取る", async (context) => {
  const data = { ...createEmptyDashboard("2025-10-14"), rows, reservations: [operational], historicalReservations: [history] };
  const abort = new AbortController(); let requested = ""; let options: RequestInit | undefined;
  context.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => { requested = url; options = init; return Response.json(data); });
  assert.deepEqual(await fetchDashboard("2025-10-14", "missmrs-takamatsu", { q: "  過去の担当  ", status: "WAITLIST" }, abort.signal), data);
  const url = new URL(requested, "https://example.invalid");
  assert.equal(url.pathname, "/api/missmrs-takamatsu/backend/dashboard");
  assert.deepEqual(Object.fromEntries(url.searchParams), { date: "2025-10-14", q: "過去の担当", status: "WAITLIST" });
  assert.equal(options?.signal, abort.signal); assert.equal(options?.cache, "no-store");
});

const plan: ReservationHistoryStaffLinkPlan = { checksum: "server-checksum", periodFrom: "2025-10-14", periodTo: "2026-10-14",
  totalCount: 1499, linkedCount: 547, pendingCount: 952, existingStaffCount: 7, newStaffCount: 7, ready: true, issues: [], groups: [
    { key: "legacy", sourceStaffName: "過去の担当<script>source</script>", count: 952, staffId: null, staffName: null, role: "ESTHETICIAN", action: "CREATE_INACTIVE", active: false, alreadyLinkedCount: 0 }
  ] };
test("担当紐付けの入口は対象店舗と三つの編集権限を全て要求する", () => {
  const permissions = ["master.write", "reservation.write", "chart.write"];
  for (const omitted of permissions) {
    const subset = permissions.filter((item) => item !== omitted);
    assert.equal(render(createElement(ReservationHistoryStaffLinkLink), subset), "");
    assert.doesNotMatch(render(createElement(ReservationHistoryStaffLink), subset), /担当の紐付けを反映/);
    assert.equal(canLinkHistoryStaff("missmrs-takamatsu", (permission) => subset.includes(permission)), false);
  }
  assert.equal(render(createElement(ReservationHistoryStaffLinkLink), permissions, "other-store"), "");
  assert.match(render(createElement(ReservationHistoryStaffLinkLink), permissions), /\/missmrs-takamatsu\/reservations\/history\/staff-link/);
  const html = render(createElement(ReservationHistoryStaffLinkPreview, { plan }), permissions);
  assert.match(html, /1,499件/); assert.match(html, /547件/); assert.match(html, /952件/); assert.match(html, /受付停止/);
  assert.match(html, /過去の担当&lt;script&gt;source&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test("紐付けはAPIが計算したプランのチェックサムだけを送り、担当IDや有効化は送らない", async (context) => {
  const calls: { url: string; options: RequestInit }[] = []; const abort = new AbortController();
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => { calls.push({ url, options }); return Response.json(url.endsWith("/prepare") ? plan : { completed: true, totalCount: 1499, linkedCount: 1499, pendingCount: 0, createdStaffCount: 7, alreadyLinkedCount: 547 }); });
  assert.deepEqual(await prepareHistoryStaffLinks("missmrs-takamatsu", abort.signal), plan);
  assert.equal((await applyHistoryStaffLinks("missmrs-takamatsu", plan.checksum, abort.signal)).completed, true);
  assert.equal(calls[0].options.body, "{}"); assert.equal(calls[1].options.body, JSON.stringify({ checksum: "server-checksum" }));
  for (const call of calls) { assert.equal(call.options.method, "POST"); assert.equal(call.options.signal, abort.signal); assert.equal(call.options.cache, "no-store"); assert.doesNotMatch(String(call.options.body), /staffId|active/); }
  context.mock.restoreAll();
  context.mock.method(globalThis, "fetch", async () => Response.json({ message: "プランが変更されています。再確認してください。" }, { status: 409 }));
  await assert.rejects(applyHistoryStaffLinks("missmrs-takamatsu", plan.checksum), /プランが変更/);
});
