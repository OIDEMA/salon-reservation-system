import { Building2 } from "lucide-react";
import { TenantSelector } from "@/components/tenant-selector";

export default function SelectTenantPage() {
  return (
    <main className="authPage">
      <section className="authCard tenantCard">
        <div className="authBrand"><Building2 size={30} /><strong>テナント選択</strong></div>
        <p>利用する事業者と店舗を選択してください。</p>
        <TenantSelector />
      </section>
    </main>
  );
}
