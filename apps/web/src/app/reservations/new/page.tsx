import { ArrowLeft, CalendarCheck, Search } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { ReservationCreateForm } from "@/components/reservation-create-form";
import { fetchAdminMenus, fetchAdminStaff } from "@/lib/admin-api";

export default async function ReservationCreatePage() {
  const [menus, staff] = await Promise.all([fetchAdminMenus(), fetchAdminStaff()]);

  return (
    <AdminShell
      active="/reservations"
      title="予約を作成"
      subtitle="顧客、メニュー、担当、通知状態をまとめて登録します。"
      badge="即時登録"
      actions={
        <>
          <a className="secondaryButton" href="/">
            <ArrowLeft size={17} />
            予約表へ
          </a>
          <a className="primaryButton" href="/reservations">
            <Search size={17} />
            予約者検索
          </a>
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
        <ReservationCreateForm menus={menus} staff={staff} defaultDate="2026-06-28" />
      </div>
    </AdminShell>
  );
}
