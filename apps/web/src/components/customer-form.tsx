"use client";

import { Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DismissibleMessage } from "@/components/dismissible-message";
import { TenantLink } from "@/components/tenant-link";
import { useTenantSlug, usePermissions } from "@/components/tenant-provider";
import type { AdminCustomer } from "@/lib/admin-types";
import { tenantApiPath, tenantPath } from "@/lib/tenant-routing";

type CustomerFormItem = Pick<AdminCustomer, "id" | "name" | "kana" | "phone" | "lineDisplayName" | "tags" | "memo">;

type CustomerFormValues = {
  name: string;
  kana: string;
  phone: string;
  lineDisplayName: string;
  tags: string;
  memo: string;
};

function initialValues(customer?: CustomerFormItem): CustomerFormValues {
  return {
    name: customer?.name ?? "",
    kana: customer?.kana ?? "",
    phone: customer?.phone ?? "",
    lineDisplayName: customer?.lineDisplayName ?? "",
    tags: customer?.tags.join(", ") ?? "",
    memo: customer?.memo ?? ""
  };
}

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? "処理に失敗しました (" + response.status + ")";
}

export function CustomerForm({ customer }: { customer?: CustomerFormItem }) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const router = useRouter();
  const [form, setForm] = useState<CustomerFormValues>(() => initialValues(customer));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function updateField(key: keyof CustomerFormValues, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function saveCustomer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const path = customer ? "/admin/customers/" + encodeURIComponent(customer.id) : "/admin/customers";
      const response = await fetch(tenantApiPath(tenantSlug, path), {
        method: customer ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          kana: form.kana.trim() || form.name.trim(),
          phone: form.phone.trim() || null,
          lineDisplayName: form.lineDisplayName.trim() || null,
          tags: form.tags.split(/[,、]/).map((tag) => tag.trim()).filter(Boolean),
          ...(can("chart.write") ? { memo: form.memo.trim() || null } : {})
        })
      });
      if (!response.ok) throw new Error(await responseError(response));
      router.push(tenantPath(tenantSlug, "/customers"));
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "顧客情報の保存に失敗しました。");
      setBusy(false);
    }
  }

  return (
    <form className="masterCreateForm" onSubmit={saveCustomer}>
      {message ? <DismissibleMessage message={message} onDismiss={() => setMessage("")} role="alert" /> : null}
      <fieldset className="masterCreateFields" disabled={busy}>
        <label className="createField"><span>氏名</span><input required maxLength={100} value={form.name} onChange={(event) => updateField("name", event.target.value)} /></label>
        <label className="createField"><span>カナ</span><input maxLength={100} value={form.kana} onChange={(event) => updateField("kana", event.target.value)} /></label>
        <label className="createField"><span>電話番号</span><input type="tel" maxLength={30} value={form.phone} onChange={(event) => updateField("phone", event.target.value)} /></label>
        <label className="createField"><span>表示名</span><input maxLength={100} value={form.lineDisplayName} onChange={(event) => updateField("lineDisplayName", event.target.value)} /></label>
        <label className="createField masterFieldWide"><span>タグ（カンマ区切り）</span><input value={form.tags} onChange={(event) => updateField("tags", event.target.value)} placeholder="要注意, VIP, 新規" /></label>
        {can("chart.write") && <label className="createField masterFieldWide"><span>顧客メモ</span><textarea rows={10} maxLength={4000} value={form.memo} onChange={(event) => updateField("memo", event.target.value)} /></label>}
      </fieldset>
      <div className="masterCreateActions">
        <TenantLink className="secondaryButton" href="/customers" aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }}>キャンセル</TenantLink>
        <button className="primaryButton" disabled={busy} type="submit"><Save size={17} />{busy ? "保存中..." : "保存"}</button>
      </div>
    </form>
  );
}
