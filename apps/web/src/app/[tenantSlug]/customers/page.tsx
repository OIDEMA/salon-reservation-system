import { AdminShell } from "@/components/admin-shell";
import { CustomerManagement } from "@/components/customer-management";
import { fetchAdminCustomerPage } from "@/lib/admin-api";

export default async function TenantCustomersPage() {
  const customerPage = await fetchAdminCustomerPage();
  return (
    <AdminShell
      active="/customers"
      title="顧客・カルテ"
    >
      <div className="adminContent">
        <CustomerManagement initialPage={customerPage} />
      </div>
    </AdminShell>
  );
}
