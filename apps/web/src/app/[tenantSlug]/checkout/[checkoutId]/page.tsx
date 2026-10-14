import { CashAccessDenied, cashPagePermissions } from "@/components/cash-access";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { CashCheckoutEditor } from "@/components/cash-views";
import { TenantLink } from "@/components/tenant-link";
import type { CashCheckout, CashRegisterSummary } from "@/components/cash-types";
import { backendFetch, backendJson } from "@/lib/backend";

export default async function CashCheckoutDetailPage({ params }: { params: Promise<{ tenantSlug: string; checkoutId: string }> }) {
  const { tenantSlug, checkoutId } = await params;
  const can = await cashPagePermissions(tenantSlug);
  if (!can("checkout.read")) return <CashAccessDenied />;
  const response = await backendFetch(`/api/cash/checkouts/${encodeURIComponent(checkoutId)}`, undefined, tenantSlug);
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error("会計を取得できませんでした。");
  const checkout = await response.json() as CashCheckout;
  const registers = can("register.read") && (can("checkout.write") || can("checkout.refund")) ? await backendJson<CashRegisterSummary[]>("/api/cash/register-sessions/options", undefined, tenantSlug) : [];
  return <AdminShell active="/checkout" title="会計詳細" actions={<TenantLink className="secondaryButton" href="/checkout">会計一覧へ</TenantLink>}><div className="adminContent"><CashCheckoutEditor initialCheckout={checkout} registers={registers} /></div></AdminShell>;
}
