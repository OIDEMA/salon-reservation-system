import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager } from "@/components/master-data-manager";
import { fetchMasterPage } from "@/lib/master-page-api";
import { menuColumns } from "@/lib/menu-form";

export default async function TenantMenusPage() {
  const page = await fetchMasterPage("menus");
  return <AdminShell active="/menus" title="メニュー管理"><div className="adminContent"><MasterDataManager resource="menus" initialPage={page} columns={menuColumns} itemLabel="メニュー" createHref="/menus/new" editBaseHref="/menus" searchPlaceholder="メニュー名・カテゴリーで検索" /></div></AdminShell>;
}
