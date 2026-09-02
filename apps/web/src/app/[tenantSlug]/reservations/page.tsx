import { CalendarCheck } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { ReservationManagement } from "@/components/reservation-management";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminMenus, fetchAdminStaff } from "@/lib/admin-api";
import type { AdminReservation } from "@/lib/admin-types";
import { backendJson } from "@/lib/backend";

export default async function TenantReservationSearchPage() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const fromDate = new Date(`${today}T00:00:00+09:00`);
  fromDate.setDate(fromDate.getDate() - 30);
  const dateFrom = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(fromDate);
  const [reservations, menus, staff] = await Promise.all([
    backendJson<AdminReservation[]>(`/api/reservations?dateFrom=${dateFrom}&dateTo=${today}`),
    fetchAdminMenus(),
    fetchAdminStaff()
  ]);

  return (
    <AdminShell
      active="/reservations"
      title="予約者検索"
      subtitle="顧客名、来店状況、予約経路、担当者をまとめて検索・更新します。"
      badge={`${reservations.length}件`}
      actions={
        <TenantLink className="primaryButton" href="/reservations/new">
          <CalendarCheck size={17} />
          予約を作成
        </TenantLink>
      }
    >
      <div className="adminContent"><ReservationManagement initialReservations={reservations} menus={menus} staff={staff} initialDateFrom={dateFrom} initialDateTo={today} /></div>
    </AdminShell>
  );
}
