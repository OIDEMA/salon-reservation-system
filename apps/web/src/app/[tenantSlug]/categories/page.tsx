import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager, type MasterColumn, type MasterField } from "@/components/master-data-manager";
import { fetchAdminCategories } from "@/lib/admin-api";

const fields: MasterField[] = [
  { key: "name", label: "カテゴリー名", required: true },
  { key: "type", label: "種別", type: "select", options: [{ value: "MENU", label: "メニュー" }, { value: "OPTION", label: "オプション" }] },
  { key: "description", label: "説明", type: "textarea" }, { key: "enabled", label: "有効", type: "checkbox" }, { key: "sortOrder", label: "表示順", type: "number" }
];
const columns: MasterColumn[] = [{ key: "name", label: "カテゴリー名" }, { key: "type", label: "種別" }, { key: "description", label: "説明" }, { key: "enabled", label: "状態", format: "boolean" }, { key: "sortOrder", label: "表示順" }];

export default async function TenantCategoriesPage() {
  const categories = await fetchAdminCategories();
  return <AdminShell active="/categories" title="カテゴリー管理"><div className="adminContent"><MasterDataManager resource="categories" initialItems={categories} fields={fields} columns={columns} itemLabel="カテゴリー" defaults={{ name: "", type: "MENU", description: "", enabled: true, sortOrder: categories.length }} /></div></AdminShell>;
}
