import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { CustomerForm } from "@/components/customer-form";
import { TenantLink } from "@/components/tenant-link";

export default function TenantCustomerCreatePage() {
  return (
    <AdminShell active="/customers" title="顧客を登録" actions={<TenantLink className="secondaryButton" href="/customers"><ArrowLeft size={17} />顧客一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <CustomerForm />
        </section>
      </div>
    </AdminShell>
  );
}
