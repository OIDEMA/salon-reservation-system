import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { MasterDataEditForm } from "@/components/master-data-manager";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminEquipment } from "@/lib/admin-api";
import { equipmentFields } from "@/lib/equipment-form";

export default async function TenantEquipmentEditPage({ params }: {
  params: Promise<{ tenantSlug: string; equipmentId: string }>;
}) {
  const { equipmentId } = await params;
  const equipment = await fetchAdminEquipment();
  const item = equipment.find((resource) => resource.id === equipmentId);
  if (!item) notFound();

  return (
    <AdminShell active="/equipment" title="設備を編集" actions={<TenantLink className="secondaryButton" href="/equipment"><ArrowLeft size={17} />設備一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <MasterDataEditForm key={item.id} resource="equipment" fields={equipmentFields} initialValues={{ ...item }} itemId={item.id} itemLabel="設備" returnHref="/equipment" />
        </section>
      </div>
    </AdminShell>
  );
}
