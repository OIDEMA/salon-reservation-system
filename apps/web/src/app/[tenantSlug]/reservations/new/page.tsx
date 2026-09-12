import { ArrowLeft, CalendarCheck, Search } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { ReservationCreateForm } from "@/components/reservation-create-form";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminMenus, fetchAdminStaff } from "@/lib/admin-api";

export default async function TenantReservationCreatePage() {
  const [menus, staff] = await Promise.all([fetchAdminMenus(), fetchAdminStaff()]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());

  return (
    <AdminShell
      active="/reservations"
      title="予約を作成"
      actions={
        <>
          <TenantLink className="secondaryButton" href="/">
            <ArrowLeft size={17} />
            予約表へ
          </TenantLink>
          <TenantLink className="primaryButton" href="/reservations">
            <Search size={17} />
            予約者検索
          </TenantLink>
        </>
      }
    >
      <div className="createReservationContent">
        <section className="createReservationHero">
          <div>
            <CalendarCheck size={28} />
            <h2>新規予約</h2>
          </div>
          <strong>{menus.length}メニュー / {staff.length}枠</strong>
        </section>
        <ReservationCreateForm menus={menus} staff={staff} defaultDate={today} />
      </div>
    </AdminShell>
  );
}
