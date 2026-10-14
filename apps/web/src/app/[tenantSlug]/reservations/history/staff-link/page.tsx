import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { ReservationHistoryStaffLink } from "@/components/reservation-history-staff-link";
import { TenantLink } from "@/components/tenant-link";

export default function ReservationHistoryStaffLinkPage() {
  return <AdminShell active="/reservations/history" title="予約履歴と担当の紐付け"
    actions={<TenantLink className="secondaryButton" href="/reservations/history"><ArrowLeft size={17} />予約履歴一覧へ</TenantLink>}>
    <div className="adminContent"><section className="adminPanel masterCreatePanel"><ReservationHistoryStaffLink /></section></div>
  </AdminShell>;
}
