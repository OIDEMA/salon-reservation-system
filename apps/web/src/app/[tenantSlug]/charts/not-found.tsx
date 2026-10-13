import { AdminShell } from "@/components/admin-shell";
import { TenantLink } from "@/components/tenant-link";

export default function ChartNotFound() {
  return <AdminShell active="/charts" title="電子カルテ"><div className="adminContent"><section className="adminPanel masterCreatePanel"><h2>カルテまたは予約が見つかりません。</h2><TenantLink className="secondaryButton" href="/charts">カルテ一覧へ</TenantLink></section></div></AdminShell>;
}
