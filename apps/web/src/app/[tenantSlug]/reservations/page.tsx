import { CalendarCheck } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { ReservationManagement } from "@/components/reservation-management";
import { TenantLink } from "@/components/tenant-link";
import type { AdminReservationPage } from "@/lib/admin-types";
import { backendJson } from "@/lib/backend";

export default async function TenantReservationSearchPage() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const fromDate = new Date(`${today}T00:00:00+09:00`);
  fromDate.setDate(fromDate.getDate() - 30);
  const dateFrom = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(fromDate);
  const reservationPage = await backendJson<AdminReservationPage>(`/api/reservations/page?dateFrom=${dateFrom}&dateTo=${today}`);

  return (
    <AdminShell
      active="/reservations"
      title="予約者検索"
      actions={
        <TenantLink className="primaryButton" href="/reservations/new">
          <CalendarCheck size={17} />
          予約を作成
        </TenantLink>
      }
    >
      <div className="adminContent"><ReservationManagement initialPage={reservationPage} initialDateFrom={dateFrom} initialDateTo={today} /></div>
    </AdminShell>
  );
}
