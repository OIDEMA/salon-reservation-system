import { AdminShell } from "@/components/admin-shell";
import { AuditManagement, type AuditData } from "@/components/access-management";
import { TenantLink } from "@/components/tenant-link";
import { backendFetch } from "@/lib/backend";

export default async function AuditPage() {
  const response=await backendFetch("/api/access/audit");
  if(response.status===403) return <AdminShell active="/access" title="操作履歴"><div className="adminContent"><section className="adminPanel">この画面を利用する権限がありません。</section></div></AdminShell>;
  if(!response.ok) throw new Error("操作履歴の取得に失敗しました。");
  const data=await response.json() as AuditData;
  return <AdminShell active="/access" title="操作履歴" actions={<TenantLink className="secondaryButton" href="/access">スタッフ権限へ</TenantLink>}><div className="adminContent"><AuditManagement initialData={data}/></div></AdminShell>;
}
