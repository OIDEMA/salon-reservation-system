import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { StaffImport } from "@/components/staff-import";
import { TenantLink } from "@/components/tenant-link";

export default function StaffImportPage() {
  return <AdminShell active="/staff" title="スタッフデータを取り込む" actions={<TenantLink className="secondaryButton" href="/staff"><ArrowLeft size={17} />スタッフ一覧へ</TenantLink>}>
    <div className="adminContent"><section className="adminPanel masterCreatePanel"><StaffImport /></section></div>
  </AdminShell>;
}
