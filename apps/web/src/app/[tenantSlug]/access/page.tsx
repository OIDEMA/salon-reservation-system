import { AdminShell } from "@/components/admin-shell";
import { AccessManagement, type AccessData } from "@/components/access-management";
import { backendFetch } from "@/lib/backend";

export default async function AccessPage() {
  const response = await backendFetch("/api/access/members");
  if (response.status === 403) return <AdminShell active="/access" title="スタッフ権限"><div className="adminContent"><section className="adminPanel">この画面を利用する権限がありません。</section></div></AdminShell>;
  if (!response.ok) throw new Error("スタッフ権限の取得に失敗しました。");
  const data = await response.json() as AccessData;
  return <AdminShell active="/access" title="スタッフ権限"><div className="adminContent"><AccessManagement data={data} /></div></AdminShell>;
}
