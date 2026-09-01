"use client";

import { createContext, useContext, type ReactNode } from "react";

const TenantSlugContext = createContext<string | null>(null);

export function TenantProvider({ tenantSlug, children }: { tenantSlug: string; children: ReactNode }) {
  return <TenantSlugContext.Provider value={tenantSlug}>{children}</TenantSlugContext.Provider>;
}

export function useTenantSlug() {
  const tenantSlug = useContext(TenantSlugContext);
  if (!tenantSlug) throw new Error("TenantProvider is required for tenant-scoped screens.");
  return tenantSlug;
}
