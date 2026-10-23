import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { ReservationDashboard } from "@/components/reservation-dashboard";
import type { TenantMembership } from "@/components/tenant-provider";
import { firstAccessibleAdminPath } from "@/lib/admin-navigation";
import { backendJson } from "@/lib/backend";
import { dashboardToday, isDashboardDocumentRequest, validDashboardDate, type DashboardPreload } from "@/lib/dashboard-preload";
import { fetchDashboardServer } from "@/lib/server-dashboard";
import { tenantPath } from "@/lib/tenant-routing";

export const dynamic = "force-dynamic";

export default async function TenantHome({ params, searchParams }: {
  params: Promise<{ tenantSlug: string }>;
  searchParams?: Promise<{ date?: string | string[] }>;
}) {
  const { tenantSlug } = await params;
  const memberships = await backendJson<TenantMembership[]>("/api/me/tenants", undefined, tenantSlug);
  const membership = memberships.find((item) => item.tenant.slug === tenantSlug);
  if (!membership) notFound();
  const firstPath = firstAccessibleAdminPath(membership);
  if (firstPath && firstPath !== "/") redirect(tenantPath(tenantSlug, firstPath));
  if (!firstPath) {
    return (
      <AdminShell active="" title="利用できる機能がありません">
        <p className="emptyState">このアカウントに利用権限が設定されていません。店舗の管理者へ確認してください。</p>
      </AdminShell>
    );
  }
  let initialData: DashboardPreload | undefined;
  // The permission/redirect checks above must finish before reading reservations.
  if ((membership.role === "OWNER" || membership.permissions?.includes("reservation.read")) && isDashboardDocumentRequest(await headers())) {
    const query = await searchParams;
    const queryDate = Array.isArray(query?.date) ? query.date[0] : query?.date;
    const date = validDashboardDate(queryDate) ?? dashboardToday();
    try {
      initialData = { tenantSlug, data: await fetchDashboardServer(date, tenantSlug) };
    } catch (error) {
      // Keep authentication/navigation errors intact; transient API errors retain
      // the existing client retry and its actionable error message.
      unstable_rethrow(error);
    }
  }
  return <ReservationDashboard initialData={initialData} renderId={randomUUID()} />;
}
