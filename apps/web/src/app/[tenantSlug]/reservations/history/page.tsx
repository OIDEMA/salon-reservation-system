import { AdminShell } from "@/components/admin-shell";
import { ReservationHistoryImportLink, ReservationHistoryList } from "@/components/reservation-history-list";
import { fetchReservationHistoryPage } from "@/lib/admin-api";

export default async function ReservationHistoryPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const historyPage = await fetchReservationHistoryPage(tenantSlug);
  return <AdminShell active="/reservations/history" title="予約履歴" actions={<ReservationHistoryImportLink />}>
    <div className="adminContent"><ReservationHistoryList initialPage={historyPage} /></div>
  </AdminShell>;
}
