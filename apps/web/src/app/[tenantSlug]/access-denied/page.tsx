import { AdminShell } from "@/components/admin-shell";
import { TenantLink } from "@/components/tenant-link";

export default function AccessDeniedPage() {
  return <AdminShell active="" title="操作権限を確認してください"><div className="adminContent"><section className="adminPanel">
    <h2>この画面を利用する権限がありません</h2><p>利用できる機能は、店舗の管理者に確認してください。</p>
    <TenantLink className="secondaryButton" href="/">利用できる画面へ戻る</TenantLink>
  </section></div></AdminShell>;
}
