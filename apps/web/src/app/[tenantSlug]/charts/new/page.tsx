import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { ChartNewForm } from "@/components/chart-new-form";
import { TenantLink } from "@/components/tenant-link";
import type { ChartReservation } from "@/components/chart-types";
import { backendFetch } from "@/lib/backend";

export default async function NewChartPage({ params, searchParams }: {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<{ reservationId?: string | string[] }>;
}) {
  const { tenantSlug } = await params;
  const query = await searchParams;
  const reservationId = typeof query.reservationId === "string" ? query.reservationId : undefined;
  let reservation: ChartReservation | undefined;
  if (reservationId) {
    const response = await backendFetch("/api/charts/reservation-context/" + encodeURIComponent(reservationId), undefined, tenantSlug);
    if (response.status === 404) notFound();
    if (response.status === 403) return <AdminShell active="/charts" title="カルテを作成"><div className="adminContent"><p className="formMessage error" role="alert">電子カルテの予約情報を閲覧する権限がありません。店舗の管理者にお問い合わせください。</p></div></AdminShell>;
    if (!response.ok) throw new Error("予約情報を取得できませんでした。");
    reservation = await response.json() as ChartReservation;
  }
  return <AdminShell active="/charts" title="カルテを作成" actions={<TenantLink className="secondaryButton" href="/charts"><ArrowLeft size={17} />カルテ一覧へ</TenantLink>}>
    <div className="adminContent"><section className="adminPanel masterCreatePanel"><ChartNewForm key={`${tenantSlug}:${reservation?.id ?? "unselected"}`} initialReservation={reservation} /></section></div>
  </AdminShell>;
}
