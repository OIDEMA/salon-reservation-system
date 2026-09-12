import { AdminShell } from "@/components/admin-shell";
import { CustomerManagement } from "@/components/customer-management";
import { fetchAdminCustomers } from "@/lib/admin-api";

export default async function TenantCustomersPage() {
  const customers = await fetchAdminCustomers();
  return (
    <AdminShell
      active="/customers"
      title="顧客・カルテ"
    >
      <div className="adminContent">
        <CustomerManagement initialCustomers={customers} />
      </div>
    </AdminShell>
  );
}
