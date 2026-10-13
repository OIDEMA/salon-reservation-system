import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager } from "@/components/master-data-manager";
import { fetchAdminCategories } from "@/lib/admin-api";
import { categoryColumns, categoryDefaults, categoryFields } from "@/lib/category-form";

export default async function TenantCategoriesPage() {
  const categories = await fetchAdminCategories();
  return <AdminShell active="/categories" title="カテゴリー管理"><div className="adminContent"><MasterDataManager resource="categories" initialItems={categories} fields={categoryFields} columns={categoryColumns} itemLabel="カテゴリー" defaults={categoryDefaults(categories.length)} createHref="/categories/new" editBaseHref="/categories" /></div></AdminShell>;
}
