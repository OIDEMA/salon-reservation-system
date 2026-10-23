import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReservationHistoryList, ReservationHistoryImportLink } from "../src/components/reservation-history-list";
import { ReservationHistoryDetail } from "../src/components/reservation-history-detail";
import { ReservationHistoryImport } from "../src/components/reservation-history-import";
import { TenantProvider } from "../src/components/tenant-provider";
import { adminNavigation } from "../src/lib/admin-navigation";
import type { ReservationHistoryDetail as Detail, ReservationHistoryImportFile, ReservationHistoryImportProgress, ReservationHistoryPage } from "../src/lib/admin-types";
import { historyAmount, historyDate, importReservationHistory, requestReservationHistoryPage, validateHistoryImportPreview } from "../src/lib/reservation-history";

function render(children: ReactNode, permissions: string[], tenantSlug = "missmrs-takamatsu") {
  return renderToStaticMarkup(createElement(TenantProvider, {
    tenantSlug, memberships: [{ role: "STAFF", permissions, tenant: { id: "tenant-test", slug: tenantSlug, name: "テスト店", salons: [{ id: "salon-test", name: "テスト店" }] } }], children
  }));
}

const detail: Detail = {
  source: "SALONBOARD", sourceStoreId: "H000551123", canReadOriginal: true,
  id: "history-test", externalReservationId: "source-reservation-test", startsAt: "2025-10-14T01:00:00Z", endsAt: null,
  durationMinutes: null, customerName: "移行顧客", customerKana: "イコウコキャク", staffName: "過去の担当",
  menuText: "移行時の施術", sourceStatus: "独自の履歴状態", normalizedStatus: null, reservationAmount: null,
  sourceRoute: "電話", customerNumber: "synthetic-number", externalCustomerId: null, externalStaffId: null,
  nominated: null, equipmentName: null, capturedAt: "2026-10-14T00:00:00Z", importedAt: "2026-10-14T01:00:00Z",
  customerId: null, staffId: null, rawHeaders: ["メモ", "メモ", "同意事項"], rawValues: ["元のメモ", "次のメモ", "<script>private</script>"]
};
const firstPage: ReservationHistoryPage = { items: [detail], page: 1, pageSize: 50, total: 120, totalPages: 3, statusOptions: ["独自の履歴状態", "キャンセル"] };

test("予約履歴は閲覧権限が必要で、元の価格・状態を読み取り専用で表示する", () => {
  assert.doesNotMatch(render(createElement(ReservationHistoryList, { initialPage: firstPage }), []), /移行顧客|過去の担当|<table/);
  const html = render(createElement(ReservationHistoryList, { initialPage: firstPage }), ["reservation.read", "reservation.write", "checkout.write", "chart.write"]);
  assert.match(html, /予約時金額/);
  assert.match(html, /独自の履歴状態/);
  assert.match(html, /過去の担当/);
  assert.match(html, /120件 \/ 1 \/ 3ページ/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>前へ<\/button>/);
  assert.doesNotMatch(html, /checkout\/new|charts\/new|reservations\/history\/history-test\/edit|元のメモ|synthetic-number/);
  assert.match(html, /href="\/missmrs-takamatsu\/reservations\/history\/history-test"/);
  const last = render(createElement(ReservationHistoryList, { initialPage: { ...firstPage, page: 3 } }), ["reservation.read"]);
  assert.match(last, /<button[^>]*disabled=""[^>]*>次へ<\/button>/);
  assert.deepEqual(adminNavigation.find((item) => item.href === "/reservations/history"), { href: "/reservations/history", label: "予約履歴", icon: "CalendarClock", permission: "reservation.read" });
});

test("予約履歴の原文は電子カルテ閲覧権限を要求し、重複する項目名を保持してHTMLを実行しない", () => {
  const blocked = render(createElement(ReservationHistoryDetail, { history: detail }), ["reservation.read"]);
  assert.doesNotMatch(blocked, /元のメモ|次のメモ|private/);
  assert.match(blocked, /電子カルテの閲覧権限/);
  const allowed = render(createElement(ReservationHistoryDetail, { history: detail }), ["reservation.read", "chart.read"]);
  assert.match(allowed, /元のメモ/); assert.match(allowed, /次のメモ/);
  assert.equal((allowed.match(/>メモ<\/th>/g) ?? []).length, 2);
  assert.match(allowed, /&lt;script&gt;private&lt;\/script&gt;/);
  assert.doesNotMatch(allowed, /<script>|<button|checkout\/new|charts\/new/);
  assert.doesNotMatch(render(createElement(ReservationHistoryDetail, { history: detail }), ["chart.read"]), /移行顧客/);
  assert.match(render(createElement(ReservationHistoryDetail, { history: { ...detail, rawHeaders: undefined, rawValues: undefined } }), ["reservation.read", "chart.read"]), /詳細情報を取得できません/);
  assert.doesNotMatch(render(createElement(ReservationHistoryDetail, { history: { ...detail, canReadOriginal: false } }), ["reservation.read", "chart.read"]), /元のメモ|次のメモ|private/);
});

test("移行の入口は正しい店舗と予約・電子カルテの両編集権限に制限する", () => {
  for (const permissions of [[], ["reservation.write"], ["chart.write"], ["reservation.read", "chart.read"]]) {
    assert.doesNotMatch(render(createElement(ReservationHistoryImport), permissions), /type="file"/);
    assert.equal(render(createElement(ReservationHistoryImportLink), permissions), "");
  }
  const permissions = ["reservation.write", "chart.write"];
  assert.doesNotMatch(render(createElement(ReservationHistoryImport), permissions, "other-store"), /type="file"/);
  assert.equal(render(createElement(ReservationHistoryImportLink), permissions, "other-store"), "");
  assert.match(render(createElement(ReservationHistoryImport), permissions), /type="file"/);
  assert.match(render(createElement(ReservationHistoryImportLink), permissions), /\/missmrs-takamatsu\/reservations\/history\/import/);
});

test("未登録の金額はゼロにせず、日時は日本時間で表示する", () => {
  assert.equal(historyAmount(null), "未登録"); assert.equal(historyAmount(0), "￥0");
  assert.match(historyDate("2025-10-13T16:00:00Z"), /2025\/10\/14.*01:00/);
  assert.equal(historyDate(null), "未登録"); assert.equal(historyDate("invalid"), "未登録");
});

test("履歴のページ移動と検索は条件をAPIへ送り、返却ページをそのまま使用する", async (context) => {
  const secondPage = { ...firstPage, items: [{ ...detail, id: "other-history", customerName: "サーバーの検索結果" }], page: 2 };
  const abort = new AbortController();
  const calls: { url: string; options?: RequestInit }[] = [];
  context.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    calls.push({ url, options }); return Response.json(secondPage);
  });
  const result = await requestReservationHistoryPage("missmrs-takamatsu", 2, { q: "  担当名・脱毛  ", from: "2025-10-01", to: "2025-10-31", sourceStatus: "独自の履歴状態" }, abort.signal);
  assert.deepEqual(result, secondPage); assert.equal(calls.length, 1);
  const url = new URL(calls[0].url, "https://example.invalid");
  assert.equal(url.pathname, "/api/missmrs-takamatsu/backend/admin/reservation-history/page");
  assert.deepEqual(Object.fromEntries(url.searchParams), { page: "2", pageSize: "50", q: "担当名・脱毛", from: "2025-10-01", to: "2025-10-31", sourceStatus: "独自の履歴状態" });
  assert.equal(calls[0].options?.cache, "no-store"); assert.equal(calls[0].options?.signal, abort.signal);
});

function importFile(count = 120): ReservationHistoryImportFile {
  return { version: 1, source: "SALONBOARD", sourceStoreId: "H000551123", periodFrom: "2025-10-14", periodTo: "2026-10-14", capturedAt: "2026-10-14T00:00:00Z", expectedCount: count, records: Array.from({ length: count }, (_, index) => ({ externalReservationId: `synthetic-${index}` })) };
}
function progress(offsets: number[]): ReservationHistoryImportProgress {
  const count = offsets.reduce((sum, offset) => sum + (offset === 100 ? 20 : 50), 0);
  return { id: "run-test", source: "SALONBOARD", sourceStoreId: "H000551123", expectedCount: 120, chunkSize: 50,
    checksum: "synthetic-checksum", processedCount: count, createdCount: count, skippedCount: 0, remainingCount: 120 - count,
    completed: count === 120, processedOffsets: offsets, periodFrom: "2025-10-14", periodTo: "2026-10-14", monthCounts: { "2025-10": 120 }, statusCounts: { "予約": 120 } };
}

test("取込前プレビューは店舗・期間・件数を確認する", () => {
  const document = importFile(); assert.equal(validateHistoryImportPreview(document), document);
  for (const change of [{ sourceStoreId: "other" }, { expectedCount: 1 }, { records: null }, { periodFrom: "2025-02-30" }, { periodTo: "2025-10-14" }, { capturedAt: "invalid" }, { expectedCount: 10001 }]) {
    assert.throws(() => validateHistoryImportPreview({ ...document, ...change }), /移行ファイル・対象期間・件数/);
  }
  assert.throws(() => validateHistoryImportPreview(null));
});

test("中断後は同じ全ファイルで準備し直し、登録済み50件を飛ばして残りを再開する", async (context) => {
  const document = importFile();
  const committed: number[] = [];
  const calls: Array<{ path: string; body: unknown }> = [];
  let interruptResponse = true;
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); const path = new URL(url, "https://example.invalid").pathname;
    calls.push({ path, body });
    if (path.endsWith("/prepare")) return Response.json(progress([...committed]));
    assert.ok(path.endsWith("/run-test/chunks"));
    assert.equal(body.records.length, body.offset === 100 ? 20 : 50);
    committed.push(body.offset);
    if (interruptResponse) { interruptResponse = false; throw new Error("synthetic interrupted response"); }
    return Response.json(progress([...committed]));
  });
  const seen: number[] = [];
  await assert.rejects(importReservationHistory("missmrs-takamatsu", document, { signal: new AbortController().signal, onProgress: (result) => seen.push(result.processedCount) }), /interrupted response/);
  const result = await importReservationHistory("missmrs-takamatsu", document, { signal: new AbortController().signal, onProgress: (result) => seen.push(result.processedCount) });
  assert.equal(result.completed, true); assert.deepEqual(committed, [0, 50, 100]);
  assert.deepEqual(calls.filter((item) => item.path.endsWith("/prepare")).map((item) => item.body), [document, document]);
  assert.deepEqual(seen, [0, 50, 100, 120]);
  assert.equal(calls.length, 5);
});

test("取込中断とAPIの検証エラーは次のチャンクへ進めない", async (context) => {
  const document = importFile(); const abort = new AbortController(); let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { ++calls; return Response.json(progress([])); });
  await assert.rejects(importReservationHistory("missmrs-takamatsu", document, { signal: abort.signal, onProgress: () => abort.abort() }), /Aborted/);
  assert.equal(calls, 1);
  context.mock.restoreAll();
  context.mock.method(globalThis, "fetch", async () => Response.json({ message: "元データを確認してください" }, { status: 422 }));
  await assert.rejects(importReservationHistory("missmrs-takamatsu", document, { signal: new AbortController().signal, onProgress: () => assert.fail("invalid file must not progress") }), /元データを確認してください/);
});


test("移動済み履歴の詳細は有効な予約表の日付へ戻り、移行時の日時と担当を別に保持する", () => {
  const history = { ...detail, scheduleOverride: { startsAt: "2025-10-16T02:30:00Z", endsAt: null, staffId: "new-staff", staffName: "移動先の担当", scheduleVersion: 2, updatedAt: "2026-10-15T00:00:00Z" } };
  const html = render(createElement(ReservationHistoryDetail, { history }), ["reservation.read"]);
  assert.match(html, /href="\/missmrs-takamatsu\?date=2025-10-16"/);
  assert.match(html, /予約表の表示位置/); assert.match(html, /移動先の担当/);
  assert.match(html, /2025\/10\/16.*11:30/); assert.match(html, /2025\/10\/14.*10:00/); assert.match(html, /過去の担当/);
  assert.doesNotMatch(html, /移行元の予約情報|<button|checkout/);
});
