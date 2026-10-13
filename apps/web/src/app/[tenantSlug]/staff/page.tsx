import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager } from "@/components/master-data-manager";
import { fetchAdminStaff } from "@/lib/admin-api";
import { staffColumns, staffDefaults, staffFields } from "@/lib/staff-form";

export default async function TenantStaffPage() {
  const staff = await fetchAdminStaff();
  return <AdminShell active="/staff" title="スタッフ管理"><div className="adminContent"><MasterDataManager resource="staff" initialItems={staff} fields={staffFields} columns={staffColumns} itemLabel="スタッフ" defaults={staffDefaults(staff.length)} createHref="/staff/new" editBaseHref="/staff" /></div></AdminShell>;
}
