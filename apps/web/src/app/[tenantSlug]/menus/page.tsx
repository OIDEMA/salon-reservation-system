import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager, type MasterColumn, type MasterField } from "@/components/master-data-manager";
import { fetchAdminMenus } from "@/lib/admin-api";

const fields: MasterField[] = [
  { key: "name", label: "メニュー名", required: true }, { key: "category", label: "カテゴリー", required: true },
  { key: "description", label: "説明", type: "textarea" }, { key: "durationMinutes", label: "所要時間（分）", type: "number" },
  { key: "price", label: "価格", type: "number" }, { key: "color", label: "予約表カラー", type: "color" },
  { key: "menuType", label: "メニュー種別" }, { key: "unlimitedBooking", label: "受付数制限なし", type: "checkbox" },
  { key: "active", label: "有効", type: "checkbox" }
];
const columns: MasterColumn[] = [
  { key: "name", label: "メニュー名" }, { key: "category", label: "カテゴリー" }, { key: "durationMinutes", label: "時間" },
  { key: "price", label: "価格", format: "currency" }, { key: "color", label: "カラー", format: "color" }, { key: "active", label: "状態", format: "boolean" }
];

export default async function TenantMenusPage() {
  const menus = await fetchAdminMenus();
  return <AdminShell active="/menus" title="メニュー管理" subtitle="予約メニュー、所要時間、価格、受付状態を管理します。" badge={`${menus.length}件`}><div className="adminContent"><MasterDataManager resource="menus" initialItems={menus} fields={fields} columns={columns} itemLabel="メニュー" defaults={{ name: "", category: "通常", description: "", durationMinutes: 60, price: 0, color: "#18c7bd", menuType: "通常メニュー", lineVisible: false, unlimitedBooking: true, active: true, sortOrder: menus.length }} /></div></AdminShell>;
}
