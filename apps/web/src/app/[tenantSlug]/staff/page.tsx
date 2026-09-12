import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager, type MasterColumn, type MasterField } from "@/components/master-data-manager";
import { fetchAdminStaff } from "@/lib/admin-api";

const fields: MasterField[] = [
  { key: "name", label: "スタッフ名", required: true },
  { key: "kana", label: "カナ" },
  { key: "role", label: "役割", type: "select", options: [
    { value: "MANAGER", label: "管理者" }, { value: "STYLIST", label: "施術スタッフ" },
    { value: "ESTHETICIAN", label: "エステ" }, { value: "ASSISTANT", label: "補助" }, { value: "ROOM_RESOURCE", label: "設備枠" }
  ] },
  { key: "color", label: "予約表カラー", type: "color" },
  { key: "nominationFee", label: "指名料", type: "number" },
  { key: "comment", label: "コメント", type: "textarea" },
  { key: "allocationOrder", label: "自動割当順", type: "number" },
  { key: "parallelCapacity", label: "同時対応数", type: "number" },
  { key: "active", label: "有効", type: "checkbox" }
];
const columns: MasterColumn[] = [
  { key: "name", label: "スタッフ名" }, { key: "role", label: "役割" }, { key: "nominationFee", label: "指名料", format: "currency" },
  { key: "allocationOrder", label: "割当順" }, { key: "parallelCapacity", label: "同時対応" }, { key: "active", label: "状態", format: "boolean" }
];

export default async function TenantStaffPage() {
  const staff = await fetchAdminStaff();
  return <AdminShell active="/staff" title="スタッフ管理"><div className="adminContent"><MasterDataManager resource="staff" initialItems={staff} fields={fields} columns={columns} itemLabel="スタッフ" defaults={{ name: "", kana: "", role: "STYLIST", color: "#18c7bd", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: staff.length }} /></div></AdminShell>;
}
