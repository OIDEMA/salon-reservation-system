import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { MasterDataEditForm } from "@/components/master-data-manager";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminCategories } from "@/lib/admin-api";
import { categoryFields } from "@/lib/category-form";

export default async function TenantCategoryEditPage({ params }: {
  params: Promise<{ tenantSlug: string; categoryId: string }>;
}) {
  const { categoryId } = await params;
  const categories = await fetchAdminCategories();
  const item = categories.find((category) => category.id === categoryId);
  if (!item) notFound();

  return (
    <AdminShell active="/categories" title="カテゴリーを編集" actions={<TenantLink className="secondaryButton" href="/categories"><ArrowLeft size={17} />カテゴリー一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <MasterDataEditForm key={item.id} resource="categories" fields={categoryFields} initialValues={{ ...item }} itemId={item.id} itemLabel="カテゴリー" returnHref="/categories" />
        </section>
      </div>
    </AdminShell>
  );
}
