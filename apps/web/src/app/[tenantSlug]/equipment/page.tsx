import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager, type MasterColumn, type MasterField } from "@/components/master-data-manager";
import { fetchAdminEquipment } from "@/lib/admin-api";

const fields: MasterField[] = [
  { key: "name", label: "設備名", required: true }, { key: "capacity", label: "同時利用数", type: "number" },
  { key: "allocationOrder", label: "割当順", type: "number" }, { key: "color", label: "予約表カラー", type: "color" },
  { key: "memo", label: "メモ", type: "textarea" }, { key: "active", label: "有効", type: "checkbox" }
];
const columns: MasterColumn[] = [{ key: "name", label: "設備名" }, { key: "capacity", label: "同時利用数" }, { key: "allocationOrder", label: "割当順" }, { key: "color", label: "カラー", format: "color" }, { key: "memo", label: "メモ" }, { key: "active", label: "状態", format: "boolean" }];

export default async function TenantEquipmentPage() {
  const equipment = await fetchAdminEquipment();
  return <AdminShell active="/equipment" title="設備管理"><div className="adminContent"><MasterDataManager resource="equipment" initialItems={equipment} fields={fields} columns={columns} itemLabel="設備" defaults={{ name: "", capacity: 1, allocationOrder: 1, color: "#18c7bd", memo: "", active: true, sortOrder: equipment.length }} /></div></AdminShell>;
}
