import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { TenantProvider, type TenantMembership } from "@/components/tenant-provider";
import { backendJson } from "@/lib/backend";
import { ACTIVE_SALON_COOKIE, ACTIVE_TENANT_SLUG_COOKIE } from "@/lib/session-constants";
import { isTenantSlug } from "@/lib/tenant-routing";

type TenantLayoutProps = {
  children: ReactNode;
  params: Promise<{ tenantSlug: string }>;
};

export default async function TenantLayout({ children, params }: TenantLayoutProps) {
  const { tenantSlug } = await params;
  if (!isTenantSlug(tenantSlug)) notFound();

  const memberships = await backendJson<TenantMembership[]>("/api/me/tenants", undefined, tenantSlug);
  if (!memberships.some((membership) => membership.tenant.slug === tenantSlug)) notFound();

  const cookieStore = await cookies();
  const activeSalonId = cookieStore.get(ACTIVE_TENANT_SLUG_COOKIE)?.value === tenantSlug
    ? cookieStore.get(ACTIVE_SALON_COOKIE)?.value
    : undefined;

  return <TenantProvider key={tenantSlug} tenantSlug={tenantSlug} memberships={memberships} activeSalonId={activeSalonId}>{children}</TenantProvider>;
}
