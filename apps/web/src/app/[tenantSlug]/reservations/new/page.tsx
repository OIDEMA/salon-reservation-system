import { ArrowLeft, Search } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { ReservationCreateForm } from "@/components/reservation-create-form";
import { TenantLink } from "@/components/tenant-link";
import { fetchReservationCatalog } from "@/lib/admin-api";

export default async function TenantReservationCreatePage() {
  const { menus, categories, staff } = await fetchReservationCatalog();
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
        <ReservationCreateForm menus={menus} categories={categories} staff={staff} defaultDate={today} />
      </div>
    </AdminShell>
  );
}
