import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager } from "@/components/master-data-manager";
import { fetchAdminEquipment } from "@/lib/admin-api";
import { equipmentColumns, equipmentDefaults, equipmentFields } from "@/lib/equipment-form";

export default async function TenantEquipmentPage() {
  const equipment = await fetchAdminEquipment();
  return <AdminShell active="/equipment" title="設備管理"><div className="adminContent"><MasterDataManager resource="equipment" initialItems={equipment} fields={equipmentFields} columns={equipmentColumns} itemLabel="設備" defaults={equipmentDefaults(equipment.length)} createHref="/equipment/new" editBaseHref="/equipment" /></div></AdminShell>;
}
