import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { MasterDataCreateForm } from "@/components/master-data-manager";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminEquipment } from "@/lib/admin-api";
import { equipmentDefaults, equipmentFields } from "@/lib/equipment-form";

export default async function TenantEquipmentCreatePage() {
  const equipment = await fetchAdminEquipment();

  return (
    <AdminShell active="/equipment" title="設備を登録" actions={<TenantLink className="secondaryButton" href="/equipment"><ArrowLeft size={17} />設備一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <MasterDataCreateForm resource="equipment" fields={equipmentFields} defaults={equipmentDefaults(equipment.length)} itemLabel="設備" returnHref="/equipment" />
        </section>
      </div>
    </AdminShell>
  );
}
