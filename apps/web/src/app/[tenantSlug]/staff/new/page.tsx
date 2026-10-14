import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { MasterDataCreateForm } from "@/components/master-data-manager";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminStaffNextSort } from "@/lib/admin-api";
import { staffDefaults, staffFields } from "@/lib/staff-form";

export default async function TenantStaffCreatePage() {
  const { sortOrder } = await fetchAdminStaffNextSort();

  return (
    <AdminShell active="/staff" title="スタッフを登録" actions={<TenantLink className="secondaryButton" href="/staff"><ArrowLeft size={17} />スタッフ一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <MasterDataCreateForm resource="staff" fields={staffFields} defaults={staffDefaults(sortOrder)} itemLabel="スタッフ" returnHref="/staff" />
        </section>
      </div>
    </AdminShell>
  );
}
