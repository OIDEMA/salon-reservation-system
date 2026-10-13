import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager } from "@/components/master-data-manager";
import { fetchAdminMenus } from "@/lib/admin-api";
import { menuColumns, menuDefaults, menuFields } from "@/lib/menu-form";

export default async function TenantMenusPage() {
  const menus = await fetchAdminMenus();
  return <AdminShell active="/menus" title="メニュー管理"><div className="adminContent"><MasterDataManager resource="menus" initialItems={menus} fields={menuFields} columns={menuColumns} itemLabel="メニュー" defaults={menuDefaults(menus.length)} createHref="/menus/new" editBaseHref="/menus" searchKeys={["name", "category"]} searchPlaceholder="メニュー名・カテゴリーで検索" /></div></AdminShell>;
}
