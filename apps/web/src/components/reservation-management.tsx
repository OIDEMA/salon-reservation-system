"use client";

import { Edit3, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { TenantLink } from "@/components/tenant-link";
import { useTenantSlug, usePermissions } from "@/components/tenant-provider";
import type { AdminReservationPage } from "@/lib/admin-types";
import { tenantApiPath } from "@/lib/tenant-routing";

const statusOptions = [
  { value: "PENDING", label: "未確認" },
  { value: "CONFIRMED", label: "確定" },
  { value: "ARRIVED", label: "来店" },
  { value: "COMPLETED", label: "完了" },
  { value: "CANCELLED", label: "取消" },
  { value: "NO_SHOW", label: "無断" },
  { value: "WAITLIST", label: "待ち" }
];
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `処理に失敗しました (${response.status})`;
}

export function ReservationManagement({
  initialPage,
  initialDateFrom,
  initialDateTo
}: {
  initialPage: AdminReservationPage;
  initialDateFrom: string;
  initialDateTo: string;
}) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const [reservationPage, setReservationPage] = useState(initialPage);
  const controller = useRef<AbortController | null>(null);
  const [appliedFilters, setAppliedFilters] = useState({ q: "", status: "", dateFrom: initialDateFrom, dateTo: initialDateTo });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState(initialDateFrom);
  const [dateTo, setDateTo] = useState(initialDateTo);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => () => { controller.current?.abort(); }, []);

  async function loadReservations(page: number, filters = appliedFilters) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(initialPage.pageSize) });
      if (filters.q.trim()) params.set("q", filters.q.trim());
      if (filters.status) params.set("status", filters.status);
      if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
      if (filters.dateTo) params.set("dateTo", filters.dateTo);
      const response = await fetch(`${tenantApiPath(tenantSlug, "/reservations/page")}?${params}`, { cache: "no-store", signal: current.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const data = await response.json() as AdminReservationPage;
      if (current.signal.aborted) return;
      setReservationPage(data);
      setAppliedFilters(filters);
    } catch (error) {
      if (!current.signal.aborted) setMessage(error instanceof Error ? error.message : "予約検索に失敗しました。");
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }

  function searchReservations() {
    void loadReservations(1, { q, status, dateFrom, dateTo });
  }

  return (
    <div className="reservationManager">
      <section className="searchPanel reservationSearchControls">
        <label className="searchBox wide"><Search size={18} /><input value={q} maxLength={100} onChange={(event) => setQ(event.target.value)} placeholder="顧客名・カナ・電話・メニュー・メモ" /></label>
        <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全ステータス</option>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        <span>〜</span>
        <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        <button className="primaryButton" disabled={busy} type="button" onClick={() => void searchReservations()}><Search size={17} />検索</button>
      </section>
      {message ? <DismissibleMessage message={message} onDismiss={() => setMessage("")} /> : null}

      <nav className="masterToolbar" aria-label="予約一覧のページ">
        <span aria-live="polite">{busy ? "検索中..." : `${reservationPage.total.toLocaleString("ja-JP")}件 / ${reservationPage.page} / ${reservationPage.totalPages}ページ`}</span>
        <div className="adminActions">
          <button className="secondaryButton" type="button" disabled={busy || reservationPage.page <= 1} onClick={() => void loadReservations(reservationPage.page - 1)}>前へ</button>
          <button className="secondaryButton" type="button" disabled={busy || reservationPage.page >= reservationPage.totalPages} onClick={() => void loadReservations(reservationPage.page + 1)}>次へ</button>
        </div>
      </nav>
      <section className="tablePanel" aria-busy={busy}>
        <table className="adminTable reservationTable">
          <thead><tr><th>日時</th><th>顧客</th><th>メニュー</th><th>担当</th><th>価格</th><th>状態</th><th>経路</th><th>操作</th></tr></thead>
          <tbody>
            {!busy && !reservationPage.reservations.length ? <tr><td colSpan={8}>該当する予約はありません。</td></tr> : null}
            {reservationPage.reservations.map((reservation) => (
              <tr key={reservation.id}>
                <td><strong>{reservation.date.replaceAll("-", "/")}</strong><small>{reservation.startTime}-{reservation.endTime}</small></td>
                <td><strong>{reservation.customer.name}</strong><small>{reservation.customer.kana} / {reservation.customer.phone || "電話未登録"}</small></td>
                <td>{reservation.service.name}</td>
                <td>{reservation.staff?.name ?? "指名なし"}</td>
                <td>{yen.format(reservation.service.price)}</td>
                <td><span className={`reservationStatus status-${reservation.status.toLowerCase()}`}>{statusOptions.find((option) => option.value === reservation.status)?.label ?? reservation.status}</span></td>
                <td>{reservation.source}</td>
                <td><div className="operationRowActions">
                  {can("reservation.write") && <TenantLink className="miniButton" href={`/reservations/${encodeURIComponent(reservation.id)}/edit`}><Edit3 size={15} />編集</TenantLink>}
                  {can("checkout.write") && <TenantLink className="miniButton" href={`/checkout/new?reservationId=${encodeURIComponent(reservation.id)}`}>会計</TenantLink>}
                  {can("chart.write") && <TenantLink className="miniButton" href={`/charts/new?reservationId=${encodeURIComponent(reservation.id)}`}>カルテ</TenantLink>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

    </div>
  );
}
