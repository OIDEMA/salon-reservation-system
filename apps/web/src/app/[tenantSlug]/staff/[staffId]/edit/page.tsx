import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { MasterDataEditForm } from "@/components/master-data-manager";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminStaff } from "@/lib/admin-api";
import { staffFields } from "@/lib/staff-form";

export default async function TenantStaffEditPage({ params }: {
  params: Promise<{ tenantSlug: string; staffId: string }>;
}) {
  const { staffId } = await params;
  const staff = await fetchAdminStaff();
  const item = staff.find((member) => member.id === staffId);
  if (!item) notFound();

  return (
    <AdminShell active="/staff" title="スタッフを編集" actions={<TenantLink className="secondaryButton" href="/staff"><ArrowLeft size={17} />スタッフ一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <MasterDataEditForm key={item.id} resource="staff" fields={staffFields} initialValues={{ ...item }} itemId={item.id} itemLabel="スタッフ" returnHref="/staff" />
        </section>
      </div>
    </AdminShell>
  );
}
