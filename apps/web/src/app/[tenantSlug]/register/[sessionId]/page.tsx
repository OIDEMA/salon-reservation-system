import { CashAccessDenied, cashPagePermissions } from "@/components/cash-access";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { CashRegisterDetail } from "@/components/cash-views";
import { TenantLink } from "@/components/tenant-link";
import type { CashRegister } from "@/components/cash-types";
import { backendFetch } from "@/lib/backend";

export default async function CashRegisterDetailPage({ params }: { params: Promise<{ tenantSlug: string; sessionId: string }> }) {
  const { tenantSlug, sessionId } = await params;
  const can = await cashPagePermissions(tenantSlug);
  if (!can("register.read")) return <CashAccessDenied area="レジ・日報" />;
  const response = await backendFetch(`/api/cash/register-sessions/${encodeURIComponent(sessionId)}`, undefined, tenantSlug);
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error("レジを取得できませんでした。");
  const register = await response.json() as CashRegister;
  return <AdminShell active="/register" title="レジ詳細・締め" actions={<TenantLink className="secondaryButton" href="/register">レジ一覧へ</TenantLink>}><div className="adminContent"><CashRegisterDetail initialRegister={register} /></div></AdminShell>;
}
