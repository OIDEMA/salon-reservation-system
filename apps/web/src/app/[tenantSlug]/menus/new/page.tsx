import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin-shell";
import { MasterDataCreateForm } from "@/components/master-data-manager";
import { TenantLink } from "@/components/tenant-link";
import { fetchAdminMenus } from "@/lib/admin-api";
import { menuDefaults, menuFields } from "@/lib/menu-form";

export default async function TenantMenuCreatePage() {
  const menus = await fetchAdminMenus();

  return (
    <AdminShell active="/menus" title="メニューを登録" actions={<TenantLink className="secondaryButton" href="/menus"><ArrowLeft size={17} />メニュー一覧へ</TenantLink>}>
      <div className="adminContent">
        <section className="adminPanel masterCreatePanel">
          <MasterDataCreateForm resource="menus" fields={menuFields} defaults={menuDefaults(menus.length)} itemLabel="メニュー" returnHref="/menus" />
        </section>
      </div>
    </AdminShell>
  );
}
