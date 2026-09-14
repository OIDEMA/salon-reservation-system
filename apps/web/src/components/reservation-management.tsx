"use client";

import { CalendarClock, CheckCircle2, Edit3, RotateCcw, Save, Search, UserCheck, UserX, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { useTenantSlug } from "@/components/tenant-provider";
import type { AdminMenu, AdminReservation, AdminStaff } from "@/lib/admin-types";
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
const sourceOptions = ["PHONE", "WEB", "WALK_IN"];
const paymentOptions = ["UNPAID", "AUTHORIZED", "PAID", "REFUNDED"];
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `処理に失敗しました (${response.status})`;
}

export function ReservationManagement({
  initialReservations,
  menus,
  staff,
  initialDateFrom,
  initialDateTo
}: {
  initialReservations: AdminReservation[];
  menus: AdminMenu[];
  staff: AdminStaff[];
  initialDateFrom: string;
  initialDateTo: string;
}) {
  const tenantSlug = useTenantSlug();
  const [reservations, setReservations] = useState(initialReservations);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState(initialDateFrom);
  const [dateTo, setDateTo] = useState(initialDateTo);
  const [selected, setSelected] = useState<AdminReservation | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const totals = useMemo(() => ({
    count: reservations.length,
    pending: reservations.filter((reservation) => reservation.status === "PENDING").length,
    completed: reservations.filter((reservation) => reservation.status === "COMPLETED").length,
    revenue: reservations.filter((reservation) => reservation.status === "COMPLETED").reduce((sum, reservation) => sum + reservation.service.price, 0)
  }), [reservations]);

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
      setSelected(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "予約検索に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus(reservation: AdminReservation, nextStatus: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/reservations/${reservation.id}/status`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const updated = (await response.json()) as AdminReservation;
      setReservations((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelected(updated);
      setMessage("予約状態を更新しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "予約状態の更新に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function saveReservation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/reservations/${selected.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: String(data.get("date")),
          startTime: String(data.get("startTime")),
          durationMinutes: Number(data.get("durationMinutes")),
          serviceId: String(data.get("serviceId")),
          staffId: String(data.get("staffId")) || null,
          source: String(data.get("source")),
          paymentStatus: String(data.get("paymentStatus")),
          memo: String(data.get("memo")).trim() || null
        })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const updated = (await response.json()) as AdminReservation;
      setReservations((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelected(updated);
      setMessage("予約内容を保存しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "予約内容の保存に失敗しました。");
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

      <section className="metricStrip compactMetrics">
        <div className="metricCard blue"><div><CalendarClock size={19} /></div><span>予約</span><strong>{totals.count}件</strong></div>
        <div className="metricCard red"><div><RotateCcw size={19} /></div><span>未確認</span><strong>{totals.pending}件</strong></div>
        <div className="metricCard green"><div><CheckCircle2 size={19} /></div><span>完了</span><strong>{totals.completed}件</strong></div>
        <div className="metricCard amber"><div><CheckCircle2 size={19} /></div><span>実績売上</span><strong>{yen.format(totals.revenue)}</strong></div>
      </section>

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
                <td><button className="miniButton" type="button" onClick={() => setSelected(reservation)}><Edit3 size={15} />編集</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {selected ? (
        <div className="drawerBackdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelected(null); }}>
          <aside className="editDrawer">
            <div className="detailPanelHeader">
              <div><span>Reservation</span><h2>{selected.customer.name}</h2><p>{selected.service.name}</p></div>
              <button className="iconOnlyButton" type="button" onClick={() => setSelected(null)}><XCircle size={19} /></button>
            </div>
            <div className="statusActionGrid">
              <button type="button" onClick={() => void updateStatus(selected, "CONFIRMED")}><CheckCircle2 size={17} />確定</button>
              <button type="button" onClick={() => void updateStatus(selected, "ARRIVED")}><UserCheck size={17} />来店</button>
              <button type="button" onClick={() => void updateStatus(selected, "COMPLETED")}><CheckCircle2 size={17} />完了</button>
              <button className="danger" type="button" onClick={() => void updateStatus(selected, "CANCELLED")}><XCircle size={17} />取消</button>
              <button className="danger" type="button" onClick={() => void updateStatus(selected, "NO_SHOW")}><UserX size={17} />無断</button>
            </div>
            <form className="reservationEditForm" key={selected.id + selected.updatedAt} onSubmit={saveReservation}>
              <div className="createFieldGrid two">
                <label className="createField"><span>日付</span><input name="date" type="date" defaultValue={selected.date} /></label>
                <label className="createField"><span>開始</span><input name="startTime" type="time" defaultValue={selected.startTime} /></label>
                <label className="createField"><span>所要時間（分）</span><input name="durationMinutes" type="number" min="5" step="5" defaultValue={selected.service.durationMinutes} /></label>
                <label className="createField"><span>担当</span><select name="staffId" defaultValue={selected.staff?.id ?? ""}><option value="">指名なし</option>{staff.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
              </div>
              <label className="createField"><span>メニュー</span><select name="serviceId" defaultValue={selected.service.id}>{menus.filter((menu) => menu.active).map((menu) => <option key={menu.id} value={menu.id}>{menu.name}（{menu.durationMinutes}分 / {yen.format(menu.price)}）</option>)}</select></label>
              <div className="createFieldGrid two">
                <label className="createField"><span>予約経路</span><select name="source" defaultValue={selected.source}>{sourceOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label className="createField"><span>決済状態（手動管理）</span><select name="paymentStatus" defaultValue={selected.paymentStatus}>{paymentOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
              </div>
              <label className="createField"><span>予約メモ</span><textarea name="memo" rows={7} defaultValue={selected.memo} /></label>
              <button className="primaryButton" disabled={busy} type="submit"><Save size={17} />{busy ? "保存中..." : "予約を保存"}</button>
            </form>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
