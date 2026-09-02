import { AdminShell } from "@/components/admin-shell";
import { SettingsManagement } from "@/components/settings-management";
import { fetchAdminSettings } from "@/lib/admin-api";

export default async function TenantSettingsPage() {
  const data = await fetchAdminSettings();
  return (
    <AdminShell
      active="/settings"
      title="基本設定"
      subtitle="営業時間、受付上限、締切、休業日をこのシステム内で管理します。"
      badge={data.salon?.name ?? "未設定"}
    >
      <div className="adminContent"><SettingsManagement initialData={data} /></div>
    </AdminShell>
  );
}
