import { CashAccessDenied, cashPagePermissions } from "@/components/cash-access";
import { AdminShell } from "@/components/admin-shell";
import { CashRegisterList } from "@/components/cash-views";
import { TenantLink } from "@/components/tenant-link";
import type { CashRegisterPage as CashRegisterPageData } from "@/components/cash-types";
import { backendJson } from "@/lib/backend";

export default async function CashRegisterPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const can = await cashPagePermissions(tenantSlug);
  if (!can("register.read")) return <CashAccessDenied area="レジ・日報" />;
  const registerPage = await backendJson<CashRegisterPageData>("/api/cash/register-sessions/page", undefined, tenantSlug);
  return <AdminShell active="/register" title="レジ・日報" actions={<>{can("checkout.read") ? <TenantLink className="secondaryButton" href="/checkout">会計へ</TenantLink> : null}{can("register.close") ? <TenantLink className="primaryButton" href="/register/new">レジ開店</TenantLink> : null}</>}><div className="adminContent"><CashRegisterList initialPage={registerPage} /></div></AdminShell>;
}
