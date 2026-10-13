import { CashAccessDenied, cashPagePermissions } from "@/components/cash-access";
import { AdminShell } from "@/components/admin-shell";
import { CashRegisterList } from "@/components/cash-views";
import { TenantLink } from "@/components/tenant-link";
import type { CashRegister } from "@/components/cash-types";
import { backendJson } from "@/lib/backend";

export default async function CashRegisterPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const can = await cashPagePermissions(tenantSlug);
  if (!can("register.read")) return <CashAccessDenied area="レジ・日報" />;
  const registers = await backendJson<CashRegister[]>("/api/cash/register-sessions", undefined, tenantSlug);
  return <AdminShell active="/register" title="レジ・日報" actions={<>{can("checkout.read") ? <TenantLink className="secondaryButton" href="/checkout">会計へ</TenantLink> : null}{can("register.close") ? <TenantLink className="primaryButton" href="/register/new">レジ開店</TenantLink> : null}</>}><div className="adminContent"><CashRegisterList registers={registers} /></div></AdminShell>;
}
