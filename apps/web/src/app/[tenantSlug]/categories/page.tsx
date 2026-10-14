import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager } from "@/components/master-data-manager";
import { fetchMasterPage } from "@/lib/master-page-api";
import { categoryColumns } from "@/lib/category-form";

export default async function TenantCategoriesPage() {
  const page = await fetchMasterPage("categories");
  return <AdminShell active="/categories" title="カテゴリー管理"><div className="adminContent"><MasterDataManager resource="categories" initialPage={page} columns={categoryColumns} itemLabel="カテゴリー" createHref="/categories/new" editBaseHref="/categories" searchPlaceholder="カテゴリー名・説明で検索" typeOptions={[{value:"MENU",label:"メニュー"},{value:"OPTION",label:"オプション"}]} /></div></AdminShell>;
}
