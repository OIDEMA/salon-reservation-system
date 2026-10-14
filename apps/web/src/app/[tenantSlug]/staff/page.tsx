import { AdminShell } from "@/components/admin-shell";
import { MasterDataManager } from "@/components/master-data-manager";
import { fetchMasterPage } from "@/lib/master-page-api";
import { staffColumns } from "@/lib/staff-form";
import { StaffImportLink } from "@/components/staff-import";

export default async function TenantStaffPage() {
  const page = await fetchMasterPage("staff");
  return <AdminShell active="/staff" title="スタッフ管理" actions={<StaffImportLink />}><div className="adminContent"><MasterDataManager resource="staff" initialPage={page} columns={staffColumns} itemLabel="スタッフ" createHref="/staff/new" editBaseHref="/staff" searchPlaceholder="スタッフ名・カナで検索" typeOptions={[{value:"MANAGER",label:"管理者"},{value:"STYLIST",label:"施術スタッフ"},{value:"ESTHETICIAN",label:"エステ"},{value:"ASSISTANT",label:"補助"},{value:"ROOM_RESOURCE",label:"設備枠"}]} /></div></AdminShell>;
}
