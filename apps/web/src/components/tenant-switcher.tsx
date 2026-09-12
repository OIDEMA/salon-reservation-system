"use client";

import { Building2, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTenantSlug } from "@/components/tenant-provider";

type Salon = {
  id: string;
  name: string;
};

type Membership = {
  role: string;
  tenant: {
    id: string;
    slug: string;
    name: string;
    salons: Salon[];
  };
};

export function TenantSwitcher() {
  const tenantSlug = useTenantSlug();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let ignore = false;

    fetch("/api/backend/me/tenants", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const result = (await response.json()) as Membership[];
        if (!ignore) setMemberships(result.filter((membership) => membership.tenant.salons.length > 0));
      })
      .catch(() => {
        if (!ignore) setMessage("テナント情報を取得できませんでした。");
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, []);

  const currentTenantName = useMemo(
    () => memberships.find((membership) => membership.tenant.slug === tenantSlug)?.tenant.name ?? tenantSlug,
    [memberships, tenantSlug]
  );

  async function switchTenant(nextTenantSlug: string) {
    if (nextTenantSlug === tenantSlug || switching) return;

    const membership = memberships.find((item) => item.tenant.slug === nextTenantSlug);
    const salon = membership?.tenant.salons[0];
    if (!membership || !salon) {
      setMessage("選択したテナントを利用できません。");
      return;
    }

    setMessage("");
    setSwitching(true);

    try {
      const response = await fetch("/api/tenant-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: membership.tenant.id, salonId: salon.id })
      });
      if (!response.ok) throw new Error();

      const result = (await response.json()) as { tenantSlug: string };
      window.location.assign(`/${encodeURIComponent(result.tenantSlug)}`);
    } catch {
      setMessage("テナントを切り替えられませんでした。もう一度お試しください。");
      setSwitching(false);
    }
  }

  return (
    <div className="tenantSwitcher">
      <div className="tenantSwitcherControl">
        <Building2 aria-hidden="true" size={18} />
        <div>
          {loading ? (
            <strong>読み込み中…</strong>
          ) : (
            <select
              aria-label="利用するテナント"
              disabled={switching || memberships.length === 0}
              onChange={(event) => void switchTenant(event.target.value)}
              value={tenantSlug}
            >
              {!memberships.some((membership) => membership.tenant.slug === tenantSlug) ? (
                <option value={tenantSlug}>{currentTenantName}</option>
              ) : null}
              {memberships.map((membership) => (
                <option key={membership.tenant.id} value={membership.tenant.slug}>
                  {membership.tenant.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <ChevronDown aria-hidden="true" className="tenantSwitcherChevron" size={16} />
      </div>
      {message ? <p className="tenantSwitcherError" role="alert">{message}</p> : null}
    </div>
  );
}
