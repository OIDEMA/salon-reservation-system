"use client";

import { AlertCircle, CalendarCheck, Save, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTenantSlug } from "@/components/tenant-provider";
import type { AdminMenu } from "@/lib/admin-types";
import { tenantApiPath, tenantPath } from "@/lib/tenant-routing";
import type { ReservationStatus, ScheduleReservation, ScheduleRow } from "@/lib/types";

const statusOptions: Array<{ value: ReservationStatus; label: string }> = [
  { value: "PENDING", label: "未確認" },
  { value: "CONFIRMED", label: "確定" },
  { value: "ARRIVED", label: "来店" },
  { value: "COMPLETED", label: "完了" },
  { value: "WAITLIST", label: "待ち" },
  { value: "CANCELLED", label: "取消" },
  { value: "NO_SHOW", label: "無断" }
];

const sourceOptions = [
  { value: "PHONE", label: "電話" },
  { value: "WEB", label: "自社Web" },
  { value: "WALK_IN", label: "来店" },
  { value: "LINE", label: "LINE" },
  { value: "MINI_APP", label: "ミニアプリ" }
];

type EditorValue = {
  kind: "create" | "edit";
  date: string;
  startTime: string;
  durationMinutes: number;
  rowId: string;
  reservation?: ScheduleReservation;
};

type TimelineReservationEditorProps = {
  value: EditorValue;
  menus: AdminMenu[];
  rows: ScheduleRow[];
  onClose: () => void;
  onSaved: () => void;
};

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `処理に失敗しました (${response.status})`;
}

function addMinutes(time: string, minutes: number) {
  const [hour, minute] = time.split(":").map(Number);
  const total = hour * 60 + minute + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function TimelineReservationEditor({ value, menus, rows, onClose, onSaved }: TimelineReservationEditorProps) {
  const tenantSlug = useTenantSlug();
  const activeMenus = useMemo(() => menus.filter((menu) => menu.active), [menus]);
  const reservation = value.reservation;
  const [customerName, setCustomerName] = useState(reservation?.customerName ?? "");
  const [customerKana, setCustomerKana] = useState(reservation?.customerKana ?? "");
  const [serviceId, setServiceId] = useState(reservation?.serviceId ?? activeMenus[0]?.id ?? "");
  const [startTime, setStartTime] = useState(value.startTime);
  const [durationMinutes, setDurationMinutes] = useState(value.durationMinutes);
  const [staffId, setStaffId] = useState(value.rowId === "unassigned" ? "" : value.rowId);
  const [status, setStatus] = useState<ReservationStatus>(reservation?.status ?? "CONFIRMED");
  const [source, setSource] = useState(reservation?.source ?? "PHONE");
  const [memo, setMemo] = useState(reservation?.memo ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const selectedMenu = activeMenus.find((menu) => menu.id === serviceId);
  const assignableRows = rows.filter((row) => row.type === "staff" || row.type === "resource");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (!selectedMenu) {
      setMessage("メニューを選択してください。");
      return;
    }
    if (value.kind === "create" && !customerName.trim()) {
      setMessage("顧客名を入力してください。");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(
        tenantApiPath(tenantSlug, value.kind === "edit" && reservation ? `/reservations/${reservation.id}` : "/reservations"),
        {
          method: value.kind === "edit" ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            value.kind === "edit"
              ? {
                  date: value.date,
                  startTime,
                  durationMinutes,
                  serviceId: selectedMenu.id,
                  staffId: staffId || null,
                  status,
                  source,
                  memo: memo.trim() || null,
                  isRequest: Boolean(staffId)
                }
              : {
                  date: value.date,
                  startTime,
                  durationMinutes,
                  serviceId: selectedMenu.id,
                  serviceName: selectedMenu.name,
                  staffId: staffId || undefined,
                  customerName: customerName.trim(),
                  customerKana: customerKana.trim() || undefined,
                  source,
                  status,
                  isRequest: Boolean(staffId),
                  memo: memo.trim() || undefined
                }
          )
        }
      );
      if (!response.ok) throw new Error(await responseError(response));
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "予約を保存できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawerBackdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onClose(); }}>
      <aside className="editDrawer timelineEditDrawer" role="dialog" aria-modal="true" aria-labelledby="timeline-editor-title">
        <header className="timelineEditorHeader">
          <div>
            <span>{value.kind === "create" ? "New reservation" : "Edit reservation"}</span>
            <h2 id="timeline-editor-title">{value.kind === "create" ? "予約を登録" : "予約を編集"}</h2>
            <p>{value.date}　{startTime}–{addMinutes(startTime, durationMinutes)}</p>
          </div>
          <button className="iconOnlyButton" type="button" aria-label="閉じる" disabled={busy} onClick={onClose}><X size={20} /></button>
        </header>

        {activeMenus.length === 0 ? (
          <div className="timelineEditorWarning">
            <AlertCircle size={18} />
            <span>予約登録にはメニューが必要です。</span>
            <a href={tenantPath(tenantSlug, "/menus")}>メニューを登録</a>
          </div>
        ) : null}

        <form className="reservationEditForm timelineEditorForm" onSubmit={submit}>
          <div className="createFieldGrid two">
            <label className="createField">
              <span>日付</span>
              <input type="date" value={value.date} readOnly />
            </label>
            <label className="createField">
              <span>開始時刻</span>
              <input type="time" step="300" value={startTime} onChange={(event) => setStartTime(event.target.value)} required />
            </label>
            <label className="createField">
              <span>所要時間（分）</span>
              <input type="number" min="5" max="1440" step="5" value={durationMinutes} onChange={(event) => setDurationMinutes(Math.max(5, Number(event.target.value) || 5))} required />
            </label>
            <label className="createField">
              <span>担当</span>
              <select value={staffId} onChange={(event) => setStaffId(event.target.value)}>
                <option value="">指名なし</option>
                {assignableRows.map((row) => <option value={row.id} key={row.id}>{row.label}</option>)}
              </select>
            </label>
          </div>

          {value.kind === "create" ? (
            <div className="createFieldGrid two">
              <label className="createField">
                <span>顧客名</span>
                <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="顧客名" autoFocus required />
              </label>
              <label className="createField">
                <span>カナ</span>
                <input value={customerKana} onChange={(event) => setCustomerKana(event.target.value)} placeholder="顧客名（カナ）" />
              </label>
            </div>
          ) : (
            <label className="createField">
              <span>顧客</span>
              <input value={customerName} readOnly />
            </label>
          )}

          <label className="createField">
            <span>メニュー</span>
            <select value={serviceId} onChange={(event) => {
              const nextId = event.target.value;
              setServiceId(nextId);
              const nextMenu = activeMenus.find((menu) => menu.id === nextId);
              if (nextMenu) setDurationMinutes(nextMenu.durationMinutes);
            }} required>
              <option value="">選択してください</option>
              {activeMenus.map((menu) => <option value={menu.id} key={menu.id}>{menu.name}（{menu.durationMinutes}分）</option>)}
            </select>
          </label>

          <div className="createFieldGrid two">
            <label className="createField">
              <span>予約状態</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as ReservationStatus)}>
                {statusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="createField">
              <span>予約経路</span>
              <select value={source} onChange={(event) => setSource(event.target.value)}>
                {sourceOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>

          <label className="createField">
            <span>予約メモ</span>
            <textarea rows={5} value={memo} onChange={(event) => setMemo(event.target.value)} />
          </label>

          {message ? <p className="timelineEditorError" role="alert"><AlertCircle size={17} />{message}</p> : null}
          <button className="primaryButton timelineEditorSubmit" type="submit" disabled={busy || activeMenus.length === 0}>
            {value.kind === "create" ? <CalendarCheck size={18} /> : <Save size={18} />}
            {busy ? "保存中…" : value.kind === "create" ? "予約を登録" : "変更を保存"}
          </button>
        </form>
      </aside>
    </div>
  );
}

export type { EditorValue as TimelineEditorValue };
