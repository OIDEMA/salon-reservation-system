import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { MasterDataCreateForm } from "@/components/master-data-manager";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminStaff } from "@/lib/admin-api";
import { staffDefaults, staffFields } from "@/lib/staff-form";

export default async function TenantStaffCreatePage() {
  const staff = await fetchAdminStaff();

  return (
    <AdminShell active="/staff" title="スタッフを登録" actions={<TenantLink className="secondaryButton" href="/staff"><ArrowLeft size={17} />スタッフ一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <MasterDataCreateForm resource="staff" fields={staffFields} defaults={staffDefaults(staff.length)} itemLabel="スタッフ" returnHref="/staff" />
        </section>
      </div>
    </AdminShell>
  );
}
