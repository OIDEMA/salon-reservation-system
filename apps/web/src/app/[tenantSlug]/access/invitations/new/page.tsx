import { AdminShell } from "@/components/admin-shell";
import { AccessAssignmentForm, type AccessData } from "@/components/access-management";
import { TenantLink } from "@/components/tenant-link";
import { backendFetch } from "@/lib/backend";

export default async function AccessInvitationPage() {
  const response=await backendFetch("/api/access/members");
  if(response.status===403) return <AdminShell active="/access" title="スタッフを招待"><div className="adminContent"><section className="adminPanel">この画面を利用する権限がありません。</section></div></AdminShell>;
  if(!response.ok) throw new Error("スタッフ権限の取得に失敗しました。");
  const data=await response.json() as AccessData;
  return <AdminShell active="/access" title="スタッフを招待" actions={<TenantLink className="secondaryButton" href="/access">一覧へ戻る</TenantLink>}><div className="adminContent"><section className="adminPanel masterCreatePanel"><AccessAssignmentForm data={data}/></section></div></AdminShell>;
}
