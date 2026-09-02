"use client";

import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTenantSlug } from "@/components/tenant-provider";
import type { AdminShift, AdminStaff } from "@/lib/admin-types";
import { tenantApiPath } from "@/lib/tenant-routing";

const typeOptions = [
  { value: "AVAILABLE", label: "出勤・受付可能" }, { value: "OFF", label: "休み" },
  { value: "BREAK", label: "休憩" }, { value: "SALES_STOP", label: "受付停止" }, { value: "TRAINING", label: "研修" }
];

export function ShiftManagement({ initialShifts, staff, defaultDate }: { initialShifts: AdminShift[]; staff: AdminStaff[]; defaultDate: string }) {
  const tenantSlug = useTenantSlug();
  const [shifts, setShifts] = useState(initialShifts);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function createShift(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const date = String(form.get("date"));
    const startTime = String(form.get("startTime"));
    const endTime = String(form.get("endTime"));
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, "/admin/shifts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: String(form.get("staffId")) || null,
          type: String(form.get("type")),
          label: String(form.get("label")).trim() || typeOptions.find((option) => option.value === String(form.get("type")))?.label,
          startsAt: `${date}T${startTime}:00+09:00`,
          endsAt: `${date}T${endTime}:00+09:00`
        })
      });
      const body = (await response.json().catch(() => null)) as AdminShift & { message?: string };
      if (!response.ok) throw new Error(body?.message ?? "シフトを登録できませんでした。");
      const selectedStaff = staff.find((member) => member.id === body.staffId);
      setShifts((current) => [...current, { ...body, staff: selectedStaff ? { id: selectedStaff.id, name: selectedStaff.name } : null }].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
      setMessage("シフトを登録しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "シフトを登録できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  async function removeShift(shift: AdminShift) {
    if (!window.confirm("このシフトを削除しますか？")) return;
    setBusy(true);
    try {
      const response = await fetch(tenantApiPath(tenantSlug, `/admin/shifts/${shift.id}`), { method: "DELETE" });
      if (!response.ok) throw new Error("シフトを削除できませんでした。");
      setShifts((current) => current.filter((item) => item.id !== shift.id));
      setMessage("シフトを削除しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "シフトを削除できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shiftManager">
      {message ? <p className="formMessage">{message}</p> : null}
      <form className="adminPanel shiftCreateForm" onSubmit={createShift}>
        <div className="adminPanelTitle"><CalendarClock size={19} /><h2>シフト・受付停止を登録</h2></div>
        <div className="createFieldGrid four">
          <label className="createField"><span>スタッフ</span><select name="staffId"><option value="">店舗全体</option>{staff.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
          <label className="createField"><span>種別</span><select name="type">{typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="createField"><span>日付</span><input name="date" type="date" defaultValue={defaultDate} /></label>
          <label className="createField"><span>表示名</span><input name="label" placeholder="例：昼休み" /></label>
          <label className="createField"><span>開始</span><input name="startTime" type="time" defaultValue="09:00" /></label>
          <label className="createField"><span>終了</span><input name="endTime" type="time" defaultValue="18:00" /></label>
        </div>
        <button className="primaryButton" disabled={busy} type="submit"><Plus size={17} />登録</button>
      </form>
      <section className="tablePanel">
        <table className="adminTable"><thead><tr><th>日時</th><th>対象</th><th>種別</th><th>表示名</th><th>操作</th></tr></thead><tbody>{shifts.map((shift) => <tr key={shift.id}><td><strong>{new Date(shift.startsAt).toLocaleDateString("ja-JP")}</strong><small>{new Date(shift.startsAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}-{new Date(shift.endsAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</small></td><td>{shift.staff?.name ?? "店舗全体"}</td><td>{typeOptions.find((option) => option.value === shift.type)?.label ?? shift.type}</td><td>{shift.label}</td><td><button className="dangerButton" disabled={busy} type="button" onClick={() => void removeShift(shift)}><Trash2 size={15} /></button></td></tr>)}</tbody></table>
      </section>
    </div>
  );
}
