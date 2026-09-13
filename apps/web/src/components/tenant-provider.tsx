"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

export type TenantMembership = {
  tenant: {
    id: string;
    slug: string;
    name: string;
    salons: Array<{ id: string; name: string }>;
  };
};

type TenantContextValue = {
  tenantSlug: string;
  memberships: TenantMembership[];
  activeSalonId?: string;
  updateSalonName: (salonId: string, name: string) => void;
};

const TenantContext = createContext<TenantContextValue | null>(null);

export function TenantProvider({ tenantSlug, memberships, activeSalonId, children }: {
  tenantSlug: string;
  memberships: TenantMembership[];
  activeSalonId?: string;
  children: ReactNode;
}) {
  const [savedSalonNames, setSavedSalonNames] = useState<Record<string, string>>({});
  const value: TenantContextValue = {
    tenantSlug,
    activeSalonId,
    memberships: memberships.map((membership) => ({
      ...membership,
      tenant: {
        ...membership.tenant,
        salons: membership.tenant.salons.map((salon) => ({
          ...salon,
          name: savedSalonNames[salon.id] ?? salon.name
        }))
      }
    })),
    updateSalonName: (salonId, name) => setSavedSalonNames((names) => ({ ...names, [salonId]: name }))
  };
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant() {
  const context = useContext(TenantContext);
  if (!context) throw new Error("TenantProvider is required for tenant-scoped screens.");
  return context;
}

export function useTenantSlug() {
  return useTenant().tenantSlug;
}
