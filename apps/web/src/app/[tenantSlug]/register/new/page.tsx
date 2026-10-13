import { CashAccessDenied, cashPagePermissions } from "@/components/cash-access";
import { AdminShell } from "@/components/admin-shell";
import { CashRegisterOpen } from "@/components/cash-views";
import { TenantLink } from "@/components/tenant-link";

export default async function CashRegisterOpenPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const can = await cashPagePermissions(tenantSlug);
  if (!can("register.close")) return <CashAccessDenied area="レジ・日報" />;
  return <AdminShell active="/register" title="レジ開店" actions={<TenantLink className="secondaryButton" href="/register">レジ一覧へ</TenantLink>}><div className="adminContent"><CashRegisterOpen /></div></AdminShell>;
}
