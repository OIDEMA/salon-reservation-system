import { notFound, redirect } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { ReservationDashboard } from "@/components/reservation-dashboard";
import type { TenantMembership } from "@/components/tenant-provider";
import { firstAccessibleAdminPath } from "@/lib/admin-navigation";
import { backendJson } from "@/lib/backend";
import { tenantPath } from "@/lib/tenant-routing";

export default async function TenantHome({ params }: { params: Promise<{ tenantSlug: string }> }) {
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
  return <ReservationDashboard />;
}
