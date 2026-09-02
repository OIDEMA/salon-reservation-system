import { AdminShell } from "@/components/admin-shell";
import { CustomerManagement } from "@/components/customer-management";
import { fetchAdminCustomers } from "@/lib/admin-api";

export default async function TenantCustomersPage() {
  const customers = await fetchAdminCustomers();
  return (
    <AdminShell
      active="/customers"
      title="顧客・カルテ"
      subtitle="顧客情報、タグ、施術メモ、予約・来店履歴を一元管理します。"
      badge={`${customers.length}名`}
    >
      <div className="adminContent">
        <CustomerManagement initialCustomers={customers} />
      </div>
    </AdminShell>
  );
}
