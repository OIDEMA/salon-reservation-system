import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { ReservationEditForm } from "@/components/reservation-edit-form";
import { TenantLink } from "@/components/tenant-link";
import type { AdminReservation } from "@/lib/admin-types";
import { fetchReservationCatalog } from "@/lib/admin-api";
import { backendFetch } from "@/lib/backend";

export default async function TenantReservationEditPage({ params }: {
  params: Promise<{ tenantSlug: string; reservationId: string }>;
}) {
  const { tenantSlug, reservationId } = await params;
  const response = await backendFetch(`/api/reservations/${encodeURIComponent(reservationId)}`, undefined, tenantSlug);
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error(`予約の取得に失敗しました (${response.status})`);
  const reservation = (await response.json()) as AdminReservation & { durationMinutes: number };
  const { menus, staff } = await fetchReservationCatalog(tenantSlug);

  return (
    <AdminShell active="/reservations" title="予約を編集" actions={
      <TenantLink className="secondaryButton" href="/reservations"><ArrowLeft size={17} />予約者検索へ</TenantLink>
    }>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <ReservationEditForm key={reservation.id} initialReservation={reservation} menus={menus} staff={staff} />
        </section>
      </div>
    </AdminShell>
  );
}
