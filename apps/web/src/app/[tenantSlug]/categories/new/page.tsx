import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { MasterDataCreateForm } from "@/components/master-data-manager";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminCategories } from "@/lib/admin-api";
import { categoryDefaults, categoryFields } from "@/lib/category-form";

export default async function TenantCategoryCreatePage() {
  const categories = await fetchAdminCategories();

  return (
    <AdminShell active="/categories" title="カテゴリーを登録" actions={<TenantLink className="secondaryButton" href="/categories"><ArrowLeft size={17} />カテゴリー一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <MasterDataCreateForm resource="categories" fields={categoryFields} defaults={categoryDefaults(categories.length)} itemLabel="カテゴリー" returnHref="/categories" />
        </section>
      </div>
    </AdminShell>
  );
}
