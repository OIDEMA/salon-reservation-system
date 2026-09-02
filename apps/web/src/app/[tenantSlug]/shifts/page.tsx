import { AdminShell } from "@/components/admin-shell";
import { ShiftManagement } from "@/components/shift-management";
import { fetchAdminStaff } from "@/lib/admin-api";
import type { AdminShift } from "@/lib/admin-types";
import { backendJson } from "@/lib/backend";

export default async function TenantShiftsPage() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const end = new Date(`${today}T00:00:00+09:00`);
  end.setDate(end.getDate() + 31);
  const dateTo = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(end);
  const [shifts, staff] = await Promise.all([
    backendJson<AdminShift[]>(`/api/admin/shifts?dateFrom=${today}&dateTo=${dateTo}`),
    fetchAdminStaff()
  ]);
  return <AdminShell active="/shifts" title="シフト・受付枠" subtitle="出勤、休み、休憩、受付停止を登録し、重複予約を防止します。" badge={`${shifts.length}件`}><div className="adminContent"><ShiftManagement initialShifts={shifts} staff={staff} defaultDate={today} /></div></AdminShell>;
}
