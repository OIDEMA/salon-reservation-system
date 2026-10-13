import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { AccessAssignmentForm, type AccessData } from "@/components/access-management";
import { TenantLink } from "@/components/tenant-link";
import { backendFetch } from "@/lib/backend";

export default async function AccessMemberEditPage({ params }: { params: Promise<{tenantSlug:string;userId:string}> }) {
  const {tenantSlug,userId} = await params;
  const response = await backendFetch("/api/access/members",undefined,tenantSlug);
  if (response.status === 403) return <AdminShell active="/access" title="スタッフ権限を編集"><div className="adminContent"><section className="adminPanel">この画面を利用する権限がありません。</section></div></AdminShell>;
  if (!response.ok) throw new Error("スタッフ権限の取得に失敗しました。");
  const data = await response.json() as AccessData;
  const member = data.members.find((item)=>item.userId===userId);
  if(!member || member.role==="OWNER" && data.actorRole!=="OWNER") notFound();
  return <AdminShell active="/access" title="スタッフ権限を編集" actions={<TenantLink className="secondaryButton" href="/access">一覧へ戻る</TenantLink>}><div className="adminContent"><section className="adminPanel masterCreatePanel"><AccessAssignmentForm key={member.userId} data={data} member={member} /></section></div></AdminShell>;
}
