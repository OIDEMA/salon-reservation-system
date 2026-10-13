"use client";

import { Edit3, Search } from "lucide-react";
import { useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { TenantLink } from "@/components/tenant-link";
import { useTenantSlug, usePermissions } from "@/components/tenant-provider";
import type { AdminReservation } from "@/lib/admin-types";
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
  initialReservations,
  initialDateFrom,
  initialDateTo
}: {
  initialReservations: AdminReservation[];
  initialDateFrom: string;
  initialDateTo: string;
}) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const [reservations, setReservations] = useState(initialReservations);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState(initialDateFrom);
  const [dateTo, setDateTo] = useState(initialDateTo);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function searchReservations() {
    setBusy(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ dateFrom, dateTo });
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      const response = await fetch(`${tenantApiPath(tenantSlug, "/reservations")}?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      setReservations((await response.json()) as AdminReservation[]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "予約検索に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reservationManager">
      <section className="searchPanel reservationSearchControls">
        <label className="searchBox wide"><Search size={18} /><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="顧客名・カナ・電話・メニュー・メモ" /></label>
        <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全ステータス</option>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        <span>〜</span>
        <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        <button className="primaryButton" disabled={busy} type="button" onClick={() => void searchReservations()}><Search size={17} />検索</button>
      </section>
      {message ? <DismissibleMessage message={message} onDismiss={() => setMessage("")} /> : null}

      <section className="tablePanel">
        <table className="adminTable reservationTable">
          <thead><tr><th>日時</th><th>顧客</th><th>メニュー</th><th>担当</th><th>価格</th><th>状態</th><th>経路</th><th>操作</th></tr></thead>
          <tbody>
            {reservations.map((reservation) => (
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
