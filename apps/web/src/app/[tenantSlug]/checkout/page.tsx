import { CashAccessDenied, cashPagePermissions } from "@/components/cash-access";
import { AdminShell } from "@/components/admin-shell";
import { CashCheckoutList } from "@/components/cash-views";
import { TenantLink } from "@/components/tenant-link";
import type { CashCheckoutPage as CashCheckoutPageData } from "@/components/cash-types";
import { backendJson } from "@/lib/backend";

export default async function CashCheckoutPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const can = await cashPagePermissions(tenantSlug);
  if (!can("checkout.read")) return <CashAccessDenied />;
  const checkoutPage = await backendJson<CashCheckoutPageData>("/api/cash/checkouts/page", undefined, tenantSlug);
  return <AdminShell active="/checkout" title="会計" actions={<>{can("checkout.write") ? <TenantLink className="primaryButton" href="/checkout/new">会計を開始</TenantLink> : null}{can("register.read") ? <TenantLink className="secondaryButton" href="/register">レジ・日報へ</TenantLink> : null}</>}><div className="adminContent"><CashCheckoutList initialPage={checkoutPage} /></div></AdminShell>;
}
