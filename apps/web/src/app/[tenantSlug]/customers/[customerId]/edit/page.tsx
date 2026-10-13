import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { CustomerForm } from "@/components/customer-form";
import { TenantLink } from "@/components/tenant-link";
import type { AdminCustomer } from "@/lib/admin-types";
import { backendFetch } from "@/lib/backend";

export default async function TenantCustomerEditPage({ params }: {
  params: Promise<{ tenantSlug: string; customerId: string }>;
}) {
  const { customerId } = await params;
  const response = await backendFetch("/api/admin/customers/" + encodeURIComponent(customerId));
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error("顧客情報を取得できませんでした。");
  const { id, name, kana, phone, lineDisplayName, tags, memo } = (await response.json()) as AdminCustomer;
  const customer = { id, name, kana, phone, lineDisplayName, tags, memo };

  return (
    <AdminShell active="/customers" title="顧客情報を編集" actions={<TenantLink className="secondaryButton" href="/customers"><ArrowLeft size={17} />顧客一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <CustomerForm key={customer.id} customer={customer} />
        </section>
      </div>
    </AdminShell>
  );
}
