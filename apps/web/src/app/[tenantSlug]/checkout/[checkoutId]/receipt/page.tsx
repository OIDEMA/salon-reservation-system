import { CashAccessDenied, cashPagePermissions } from "@/components/cash-access";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { CashReceiptPrint } from "@/components/cash-views";
import { ReceiptEmail } from "@/components/receipt-email";
import { TenantLink } from "@/components/tenant-link";
import { cashMethodLabels, cashYen, type CashCheckout } from "@/components/cash-types";
import { backendFetch } from "@/lib/backend";
import type { ReceiptEmailContext } from "@/lib/receipt-email";

export default async function CashReceiptPage({ params }: { params: Promise<{ tenantSlug: string; checkoutId: string }> }) {
  const { tenantSlug, checkoutId } = await params;
  const can = await cashPagePermissions(tenantSlug);
  if (!can("checkout.read")) return <CashAccessDenied />;
  const response = await backendFetch(`/api/cash/checkouts/${encodeURIComponent(checkoutId)}`, undefined, tenantSlug);
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error("会計控えを取得できませんでした。");
  const checkout = await response.json() as CashCheckout;
  if (checkout.status === "DRAFT") notFound();
  let receiptEmails: ReceiptEmailContext | null = null;
  let receiptEmailError = "";
  try {
    const emailResponse = await backendFetch(`/api/cash/checkouts/${encodeURIComponent(checkoutId)}/receipt-emails`, undefined, tenantSlug);
    if (!emailResponse.ok) throw new Error("送付履歴を取得できませんでした。再取得してください。");
    receiptEmails = await emailResponse.json() as ReceiptEmailContext;
  } catch { receiptEmailError = "送付履歴を取得できませんでした。再取得してください。"; }
  return <AdminShell active="/checkout" title="領収書・会計控え" actions={<TenantLink className="secondaryButton" href={`/checkout/${checkoutId}`}>会計詳細へ</TenantLink>}>
    <div className="adminContent"><ReceiptEmail key={`${checkout.id}:${checkout.version}`} checkout={checkout} initialData={receiptEmails} initialError={receiptEmailError} /><article className="adminPanel cashReceipt"><div className="cashHeading"><h1>会計控え</h1><CashReceiptPrint /></div>
      {checkout.status === "REVERSED" ? <h2 className="cashDifference">全額取消済み</h2> : null}
      <p>{checkout.reservationSnapshot.salonName}</p><h2>{checkout.reservationSnapshot.customerName} 様</h2>
      <p>会計番号 {checkout.id}<br />確定日時 {checkout.finalizedAt ? new Date(checkout.finalizedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : ""}</p>
      <strong className="cashReceiptTotal">{cashYen(checkout.totalYen)}</strong>
      <table className="adminTable"><thead><tr><th>内容</th><th>数量</th><th>税込単価</th><th>値引内訳</th><th>税込金額</th></tr></thead><tbody>{checkout.items.map((item, index) => <tr key={index}><td>{item.label} {item.taxRate === 8 ? "（8%）" : item.taxRate === 0 ? "（0%）" : ""}</td><td>{item.quantity}</td><td>{cashYen(item.unitPriceYen)}</td><td>{cashYen(item.discountYen)}{item.pointsDiscountYen ? <small>ポイント {cashYen(item.pointsDiscountYen)}</small> : null}</td><td>{cashYen(item.totalYen ?? item.quantity * item.unitPriceYen - item.discountYen - (item.pointsDiscountYen ?? 0))}</td></tr>)}</tbody></table>
      <dl className="cashReceiptTotals"><div><dt>税込小計</dt><dd>{cashYen(checkout.subtotalYen)}</dd></div><div><dt>通常値引</dt><dd>{cashYen(checkout.discountYen)}</dd></div><div><dt>ポイント値引</dt><dd>{cashYen(checkout.pointsDiscountYen ?? 0)}</dd></div><div><dt>合計（値引後）</dt><dd>{cashYen(checkout.totalYen)}</dd></div>{checkout.taxBreakdown.map((tax) => <div key={tax.taxRate}><dt>{tax.taxRate}%対象 {cashYen(tax.taxableTotalYen)}・内税</dt><dd>{cashYen(tax.taxYen)}</dd></div>)}</dl>
      <h3>支払記録</h3>{checkout.payments.map((payment, index) => <p key={index}>{cashMethodLabels[payment.method]} {cashYen(payment.amountYen)}{payment.reference ? ` / ${payment.reference}` : ""}</p>)}
      <p>{checkout.notes}</p>{checkout.status === "REVERSED" ? <p>取消理由 {checkout.reversalReason}<br />取消日時 {checkout.reversedAt ? new Date(checkout.reversedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : ""}</p> : null}
      <p className="cashReceiptFootnote">店舗の会計記録の控えです。適格請求書の登録番号は記載していません。</p>
    </article></div>
  </AdminShell>;
}
