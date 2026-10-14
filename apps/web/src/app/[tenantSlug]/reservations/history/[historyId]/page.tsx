import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { ReservationHistoryDetail } from "@/components/reservation-history-detail";
import { TenantLink } from "@/components/tenant-link";
import { fetchReservationHistoryDetail } from "@/lib/admin-api";

export default async function ReservationHistoryDetailPage({ params }: { params: Promise<{ tenantSlug: string; historyId: string }> }) {
  const { tenantSlug, historyId } = await params;
  const history = await fetchReservationHistoryDetail(tenantSlug, historyId);
  if (!history) notFound();
  return <AdminShell active="/reservations/history" title="予約履歴の詳細" actions={<TenantLink className="secondaryButton" href="/reservations/history"><ArrowLeft size={17} />予約履歴一覧へ</TenantLink>}>
    <div className="adminContent"><ReservationHistoryDetail history={history} /></div>
  </AdminShell>;
}
