"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

export type LoginUser = {
  displayName: string | null;
  email: string | null;
};

export type TenantMembership = {
  role?: "OWNER" | "ADMIN" | "MANAGER" | "STAFF" | "VIEWER";
  permissions?: string[];
  tenant: {
    id: string;
    slug: string;
    name: string;
    salons: Array<{ id: string; name: string; timezone?: string }>;
  };
};

type TenantContextValue = {
  currentUser?: LoginUser;
  tenantSlug: string;
  memberships: TenantMembership[];
  activeSalonId?: string;
  updateSalonName: (salonId: string, name: string) => void;
  role?: TenantMembership["role"];
  permissions: string[];
  can: (permission: string) => boolean;
};

const TenantContext = createContext<TenantContextValue | null>(null);

export function TenantProvider({ tenantSlug, memberships, activeSalonId, currentUser, children }: {
  tenantSlug: string;
  memberships: TenantMembership[];
  activeSalonId?: string;
  currentUser?: LoginUser;
  children: ReactNode;
}) {
  const [savedSalonNames, setSavedSalonNames] = useState<Record<string, string>>({});
  const activeMembership = memberships.find((membership) => membership.tenant.slug === tenantSlug);
  const permissions = activeMembership?.permissions ?? [];
  const salonIds = activeMembership?.tenant.salons.map((salon) => salon.id) ?? [];
  const value: TenantContextValue = {
    currentUser,
    tenantSlug,
    activeSalonId: activeSalonId && salonIds.includes(activeSalonId) ? activeSalonId : salonIds[0],
    role: activeMembership?.role,
    permissions,
    can: (permission) => activeMembership?.role === "OWNER" || permissions.includes(permission),
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

export function usePermissions() {
  const { can, role, permissions } = useTenant();
  return { can, role, permissions };
}
