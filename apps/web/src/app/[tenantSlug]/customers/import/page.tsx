import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { CustomerImport } from "@/components/customer-import";
import { TenantLink } from "@/components/tenant-link";

export default function CustomerImportPage() {
  return <AdminShell active="/customers" title="顧客データを取り込む" actions={<TenantLink className="secondaryButton" href="/customers"><ArrowLeft size={17} />顧客一覧へ</TenantLink>}>
    <div className="adminContent"><section className="adminPanel masterCreatePanel"><CustomerImport /></section></div>
  </AdminShell>;
}
