import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { CashAccessDenied, cashPagePermissions } from "@/components/cash-access";
import { CashCheckoutCreate } from "@/components/cash-views";
import { TenantLink } from "@/components/tenant-link";
import type { AdminReservation } from "@/lib/admin-types";
import { backendFetch, backendJson } from "@/lib/backend";

export default async function CashCheckoutNewPage({ params, searchParams }: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ reservationId?: string | string[] }>;
}) {
  const { tenantSlug } = await params;
  const can = await cashPagePermissions(tenantSlug);
  if (!can("checkout.write")) return <CashAccessDenied />;
  const query = await searchParams;
  const reservationId = typeof query.reservationId === "string" ? query.reservationId : "";
  let reservations: AdminReservation[] = [];
  if (can("reservation.read")) {
    if (reservationId) {
      const response = await backendFetch(`/api/reservations/${encodeURIComponent(reservationId)}`, undefined, tenantSlug);
      if (response.status === 404) notFound();
      if (!response.ok) throw new Error("予約を取得できませんでした。");
      reservations = [await response.json() as AdminReservation];
    } else reservations = await backendJson<AdminReservation[]>("/api/reservations", undefined, tenantSlug);
  }
  return <AdminShell active="/checkout" title="会計を開始" actions={<TenantLink className="secondaryButton" href="/checkout">会計一覧へ</TenantLink>}><div className="adminContent"><CashCheckoutCreate reservations={reservations} initialReservationId={reservationId} /></div></AdminShell>;
}
