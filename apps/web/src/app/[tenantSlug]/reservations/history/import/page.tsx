import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { ReservationHistoryImport } from "@/components/reservation-history-import";
import { TenantLink } from "@/components/tenant-link";

export default function ReservationHistoryImportPage() {
  return <AdminShell active="/reservations/history" title="予約履歴を取り込む" actions={<TenantLink className="secondaryButton" href="/reservations/history"><ArrowLeft size={17} />予約履歴一覧へ</TenantLink>}>
    <div className="adminContent"><section className="adminPanel masterCreatePanel"><ReservationHistoryImport /></section></div>
  </AdminShell>;
}
