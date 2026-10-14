import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager } from "@/components/master-data-manager";
import { fetchMasterPage } from "@/lib/master-page-api";
import { equipmentColumns } from "@/lib/equipment-form";

export default async function TenantEquipmentPage() {
  const page = await fetchMasterPage("equipment");
  return <AdminShell active="/equipment" title="設備管理"><div className="adminContent"><MasterDataManager resource="equipment" initialPage={page} columns={equipmentColumns} itemLabel="設備" createHref="/equipment/new" editBaseHref="/equipment" searchPlaceholder="設備名・メモで検索" /></div></AdminShell>;
}
