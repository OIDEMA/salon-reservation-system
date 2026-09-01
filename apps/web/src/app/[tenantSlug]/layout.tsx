import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { TenantProvider } from "@/components/tenant-provider";
import { backendJson } from "@/lib/backend";
import { isTenantSlug } from "@/lib/tenant-routing";

type TenantLayoutProps = {
  children: ReactNode;
  params: Promise<{ tenantSlug: string }>;
};

type Membership = {
  tenant: { slug: string };
};

export default async function TenantLayout({ children, params }: TenantLayoutProps) {
  const { tenantSlug } = await params;
  if (!isTenantSlug(tenantSlug)) notFound();

  const memberships = await backendJson<Membership[]>("/api/me/tenants", undefined, tenantSlug);
  if (!memberships.some((membership) => membership.tenant.slug === tenantSlug)) notFound();

  return <TenantProvider tenantSlug={tenantSlug}>{children}</TenantProvider>;
}
