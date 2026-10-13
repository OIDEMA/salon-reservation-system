import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { MasterDataEditForm } from "@/components/master-data-manager";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminMenus } from "@/lib/admin-api";
import { menuFields } from "@/lib/menu-form";

export default async function TenantMenuEditPage({ params }: {
  params: Promise<{ tenantSlug: string; menuId: string }>;
}) {
  const { menuId } = await params;
  const menus = await fetchAdminMenus();
  const item = menus.find((menu) => menu.id === menuId);
  if (!item) notFound();

  return (
    <AdminShell active="/menus" title="メニューを編集" actions={<TenantLink className="secondaryButton" href="/menus"><ArrowLeft size={17} />メニュー一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <MasterDataEditForm key={item.id} resource="menus" fields={menuFields} initialValues={{ ...item }} itemId={item.id} itemLabel="メニュー" returnHref="/menus" />
        </section>
      </div>
    </AdminShell>
  );
}
