"use client";

import { CheckCircle2, Save, UserCheck, UserX, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { ReservationStaffTools } from "@/components/reservation-staff-tools";
import { TenantLink } from "@/components/tenant-link";
import { useTenantSlug } from "@/components/tenant-provider";
import type { AdminMenu, AdminReservation, AdminStaff } from "@/lib/admin-types";
import { tenantApiPath, tenantPath } from "@/lib/tenant-routing";

type EditableReservation = AdminReservation & { durationMinutes: number };

const sourceOptions = ["PHONE", "WEB", "WALK_IN"];
const paymentLabels: Record<string, string> = { UNPAID: "未精算", AUTHORIZED: "事前承認", PAID: "精算済み", REFUNDED: "取消・返金済み" };
const statusLabels: Record<string, string> = {
  PENDING: "未確認", CONFIRMED: "確定", ARRIVED: "来店", COMPLETED: "完了",
  CANCELLED: "取消", NO_SHOW: "無断", WAITLIST: "待ち"
};
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `処理に失敗しました (${response.status})`;
}

export function ReservationEditForm({ initialReservation, menus, staff }: {
  initialReservation: EditableReservation;
  menus: AdminMenu[];
  staff: AdminStaff[];
}) {
  const tenantSlug = useTenantSlug();
  const router = useRouter();
  const [reservation, setReservation] = useState(initialReservation);
  const [selectedStaffId, setSelectedStaffId] = useState(initialReservation.staff?.id ?? "");
  const [pending, setPending] = useState<"save" | "status" | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const busy = pending !== null;
  const availableMenus = menus.filter((menu) => menu.active || menu.id === reservation.service.id);
  const availableStaff = staff.filter((member) => member.active || member.id === reservation.staff?.id);
  const sources = Array.from(new Set([reservation.source, ...sourceOptions]));

  async function updateStatus(nextStatus: string) {
    if (busy) return;
    setPending("status");
    setMessage(null);
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/reservations/${encodeURIComponent(reservation.id)}/status`), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const updated = (await response.json()) as AdminReservation;
      setReservation((current) => ({ ...updated, durationMinutes: current.durationMinutes }));
      setMessage({ type: "success", text: "予約状態を更新しました。" });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "予約状態の更新に失敗しました。" });
    } finally {
      setPending(null);
    }
  }

  async function saveReservation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const serviceId = String(data.get("serviceId"));
    const staffId = selectedStaffId || null;
    if (staffId && staffId !== reservation.staff?.id && !availableStaff.some((member) => member.id === staffId && member.active)) {
      setMessage({ type: "error", text: "選択したスタッフは現在予約を受け付けていません。担当を選び直してください。" });
      return;
    }
    setPending("save");
    setMessage(null);
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/reservations/${encodeURIComponent(reservation.id)}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: String(data.get("date")), startTime: String(data.get("startTime")),
          durationMinutes: Number(data.get("durationMinutes")),
          ...(serviceId !== reservation.service.id ? { serviceId } : {}),
          ...(staffId !== (reservation.staff?.id ?? null) ? { staffId } : {}),
          source: String(data.get("source")),
          memo: String(data.get("memo")).trim() || null
        })
      });
      if (!response.ok) throw new Error(await responseError(response));
      router.push(tenantPath(tenantSlug, "/reservations"));
      router.refresh();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "予約内容の保存に失敗しました。" });
      setPending(null);
    }
  }

  return (
    <div className="reservationFormStack">
      <div className="detailPanelHeader">
        <div><span>Reservation</span><h2>{reservation.customer.name}</h2><p>{reservation.service.name}</p></div>
        <span className={`reservationStatus status-${reservation.status.toLowerCase()}`}>{statusLabels[reservation.status] ?? reservation.status}</span>
      </div>
      {message ? <DismissibleMessage className={message.type === "error" ? "formMessage error" : "formMessage"} role={message.type === "error" ? "alert" : "status"} message={message.text} onDismiss={() => setMessage(null)} /> : null}
      <div className="statusActionGrid">
        <button disabled={busy} type="button" onClick={() => void updateStatus("CONFIRMED")}><CheckCircle2 size={17} />確定</button>
        <button disabled={busy} type="button" onClick={() => void updateStatus("ARRIVED")}><UserCheck size={17} />来店</button>
        <button disabled={busy} type="button" onClick={() => void updateStatus("COMPLETED")}><CheckCircle2 size={17} />完了</button>
        <button disabled={busy} className="danger" type="button" onClick={() => void updateStatus("CANCELLED")}><XCircle size={17} />取消</button>
        <button disabled={busy} className="danger" type="button" onClick={() => void updateStatus("NO_SHOW")}><UserX size={17} />無断</button>
      </div>
      <form className="reservationEditForm" key={reservation.id} onSubmit={saveReservation}>
        <div className="createFieldGrid two">
          <label className="createField"><span>日付</span><input disabled={busy} required name="date" type="date" defaultValue={reservation.date} /></label>
          <label className="createField"><span>開始</span><input disabled={busy} required name="startTime" type="time" defaultValue={reservation.startTime} /></label>
          <label className="createField"><span>所要時間（分）</span><input disabled={busy} required name="durationMinutes" type="number" min="1" max="1440" step="1" defaultValue={reservation.durationMinutes} /></label>
          <label className="createField"><span>担当</span><select disabled={busy} name="staffId" value={selectedStaffId} onChange={(event) => setSelectedStaffId(event.target.value)}>
            <option value="">指名なし</option>
            {selectedStaffId && selectedStaffId !== reservation.staff?.id && !availableStaff.some((member) => member.id === selectedStaffId) ? <option value={selectedStaffId} disabled>担当を選び直してください</option> : null}
            {reservation.staff && !availableStaff.some((member) => member.id === reservation.staff?.id) ? <option value={reservation.staff.id}>{reservation.staff.name}（現在の担当）</option> : null}
            {availableStaff.map((member) => <option key={member.id} value={member.id}>{member.name}{member.active ? "" : "（停止中）"}</option>)}
          </select></label>
        </div>
        <ReservationStaffTools empty={!staff.some((member) => member.active)} disabled={busy} />
        <label className="createField"><span>メニュー</span><select disabled={busy} required name="serviceId" defaultValue={reservation.service.id}>
          {!availableMenus.some((menu) => menu.id === reservation.service.id) ? <option value={reservation.service.id}>{reservation.service.name}（現在のメニュー）</option> : null}
          {availableMenus.map((menu) => <option key={menu.id} value={menu.id}>{menu.name}（{menu.durationMinutes}分 / {yen.format(menu.price)}）{menu.active ? "" : "（停止中）"}</option>)}
        </select></label>
        <div className="createFieldGrid two">
          <label className="createField"><span>予約経路</span><select disabled={busy} name="source" defaultValue={reservation.source}>{sources.map((value) => <option key={value}>{value}</option>)}</select></label>
          <div className="createField"><span>会計状態</span><strong>{paymentLabels[reservation.paymentStatus] ?? reservation.paymentStatus}</strong></div>
        </div>
        <label className="createField"><span>予約メモ</span><textarea disabled={busy} name="memo" rows={7} defaultValue={reservation.memo} /></label>
        <div className="masterCreateActions">
          <TenantLink className="secondaryButton" href="/reservations" aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }}>キャンセル</TenantLink>
          <button className="primaryButton" disabled={busy} type="submit"><Save size={17} />{pending === "save" ? "保存中..." : "予約を保存"}</button>
        </div>
      </form>
    </div>
  );
}
