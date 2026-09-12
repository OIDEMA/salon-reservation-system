import { AdminShell } from "@/components/admin-shell";
import { SettingsManagement } from "@/components/settings-management";
import { fetchAdminSettings } from "@/lib/admin-api";

export default async function TenantSettingsPage() {
  const data = await fetchAdminSettings();
  return (
    <AdminShell
      active="/settings"
      title="基本設定"
    >
      <div className="adminContent"><SettingsManagement initialData={data} /></div>
    </AdminShell>
  );
}
