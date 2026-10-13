import "server-only";
import { AdminShell } from "@/components/admin-shell";
import type { TenantMembership } from "@/components/tenant-provider";
import { backendJson } from "@/lib/backend";

export async function cashPagePermissions(tenantSlug: string) {
  const memberships = await backendJson<TenantMembership[]>("/api/me/tenants", undefined, tenantSlug);
  const membership = memberships.find((entry) => entry.tenant.slug === tenantSlug);
  return (permission: string) => membership?.role === "OWNER" || Boolean(membership?.permissions?.includes(permission));
}

export function CashAccessDenied({ area = "会計" }: { area?: string }) {
  return <AdminShell active={area === "会計" ? "/checkout" : "/register"} title={area}><div className="adminContent"><p className="formMessage error" role="alert">この画面を利用する権限がありません。店舗の管理者にお問い合わせください。</p></div></AdminShell>;
}
