"use client";

import { Search, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReservationHistoryPage } from "@/lib/admin-types";
import { emptyHistoryFilters, historyAmount, historyDate, requestReservationHistoryPage, type ReservationHistoryFilters } from "@/lib/reservation-history";
import { TenantLink } from "./tenant-link";
import { usePermissions, useTenantSlug } from "./tenant-provider";

export function ReservationHistoryImportLink() {
  const { can } = usePermissions();
  const tenantSlug = useTenantSlug();
  if (tenantSlug !== "missmrs-takamatsu" || !can("reservation.write") || !can("chart.write")) return null;
  return <TenantLink className="secondaryButton" href="/reservations/history/import"><Upload size={17} />予約履歴を取り込む</TenantLink>;
}

export function ReservationHistoryList({ initialPage, initialFilters = emptyHistoryFilters }: {
  initialPage: ReservationHistoryPage; initialFilters?: ReservationHistoryFilters;
}) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const [historyPage, setHistoryPage] = useState(initialPage);
  const [filters, setFilters] = useState(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState(initialFilters);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  if (!can("reservation.read")) return <p className="formMessage error" role="alert">予約履歴を閲覧する権限がありません。</p>;

  async function loadPage(page: number, nextFilters = appliedFilters) {
    if (nextFilters.from && nextFilters.to && nextFilters.from > nextFilters.to) {
      setMessage("終了日は開始日以降を選択してください。");
      return;
    }
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setMessage("");
    try {
      const data = await requestReservationHistoryPage(tenantSlug, page, nextFilters, current.signal);
      if (current.signal.aborted) return;
      setHistoryPage(data); setAppliedFilters(nextFilters);
    } catch (error) {
      if (!current.signal.aborted) setMessage(error instanceof Error ? error.message : "予約履歴を取得できませんでした。");
    } finally { if (!current.signal.aborted) setBusy(false); }
  }

  return <div className="reservationManager">
    <form className="searchPanel reservationSearchControls historySearchControls" onSubmit={(event) => { event.preventDefault(); void loadPage(1, filters); }}>
      <label className="searchBox wide"><Search size={18} /><input aria-label="予約履歴を検索" value={filters.q} maxLength={100} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="顧客名・カナ・担当・メニュー・予約番号" /></label>
      <select aria-label="移行元の予約状態" value={filters.sourceStatus} onChange={(event) => setFilters({ ...filters, sourceStatus: event.target.value })}>
        <option value="">すべての状態</option>{historyPage.statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
      </select>
      <input type="date" aria-label="開始日" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
      <span>〜</span>
      <input type="date" aria-label="終了日" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
      <button className="primaryButton" type="submit" disabled={busy}><Search size={17} />検索</button>
    </form>
    {message ? <p className="formMessage error" role="alert">{message}</p> : null}
    <nav className="masterToolbar" aria-label="予約履歴一覧のページ">
      <span aria-live="polite">{busy ? "検索中..." : `${historyPage.total.toLocaleString("ja-JP")}件 / ${historyPage.page} / ${Math.max(1, historyPage.totalPages)}ページ`}</span>
      <div className="adminActions">
        <button className="secondaryButton" type="button" disabled={busy || historyPage.page <= 1} onClick={() => void loadPage(historyPage.page - 1)}>前へ</button>
        <button className="secondaryButton" type="button" disabled={busy || historyPage.page >= historyPage.totalPages} onClick={() => void loadPage(historyPage.page + 1)}>次へ</button>
      </div>
    </nav>
    <section className="tablePanel" aria-busy={busy}>
      <table className="adminTable reservationTable historyTable">
        <thead><tr><th>日時</th><th>顧客</th><th>メニュー</th><th>担当</th><th>予約時金額</th><th>移行元の状態</th><th>経路</th><th>詳細</th></tr></thead>
        <tbody>
          {!historyPage.items.length ? <tr><td colSpan={8}>該当する予約履歴はありません。</td></tr> : null}
          {historyPage.items.map((item) => <tr key={item.id}>
            <td><strong>{historyDate(item.startsAt)}</strong>{item.endsAt ? <small>終了 {historyDate(item.endsAt, { year: undefined, month: undefined, day: undefined })}</small> : item.durationMinutes !== null ? <small>{item.durationMinutes}分</small> : null}</td>
            <td>{item.customerName}</td>
            <td className="historyMenuCell">{item.menuText || "未登録"}</td>
            <td>{item.staffName || "担当未登録"}</td>
            <td>{historyAmount(item.reservationAmount)}</td>
            <td><span className="reservationStatus">{item.sourceStatus}</span></td>
            <td>{item.sourceRoute || "未登録"}</td>
            <td><TenantLink className="miniButton" href={`/reservations/history/${encodeURIComponent(item.id)}`}>開く</TenantLink></td>
          </tr>)}
        </tbody>
      </table>
    </section>
  </div>;
}
