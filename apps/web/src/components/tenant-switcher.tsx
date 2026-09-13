"use client";

import { Building2, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTenant, type TenantMembership } from "@/components/tenant-provider";

export function TenantSwitcher() {
  const { tenantSlug, memberships: allMemberships, activeSalonId } = useTenant();
  const memberships = allMemberships.filter((membership) => membership.tenant.salons.length > 0);
  const [switching, setSwitching] = useState(false);
  const [message, setMessage] = useState("");

  function displayName({ tenant }: TenantMembership) {
    const salon = tenant.slug === tenantSlug
      ? tenant.salons.find((item) => item.id === activeSalonId) ?? tenant.salons[0]
      : tenant.salons[0];
    return salon?.name || tenant.name;
  }

  const currentMembership = allMemberships.find((membership) => membership.tenant.slug === tenantSlug);
  const currentSalonName = currentMembership ? displayName(currentMembership) : tenantSlug;

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
          <select
            aria-label="利用する店舗"
            disabled={switching || memberships.length === 0}
            onChange={(event) => void switchTenant(event.target.value)}
            value={tenantSlug}
          >
            {!memberships.some((membership) => membership.tenant.slug === tenantSlug) ? (
              <option value={tenantSlug}>{currentSalonName}</option>
            ) : null}
            {memberships.map((membership) => (
              <option key={membership.tenant.id} value={membership.tenant.slug}>
                {displayName(membership)}
              </option>
            ))}
          </select>
        </div>
        <ChevronDown aria-hidden="true" className="tenantSwitcherChevron" size={16} />
      </div>
      {message ? <p className="tenantSwitcherError" role="alert">{message}</p> : null}
    </div>
  );
}
