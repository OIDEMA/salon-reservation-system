import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_SALON_COOKIE, ACTIVE_TENANT_COOKIE, ACTIVE_TENANT_SLUG_COOKIE, SESSION_COOKIE } from "./session-constants";
import { TENANT_SLUG_HEADER } from "./tenant-routing";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4001";

export async function backendFetch(path: string, init?: RequestInit, tenantSlugOverride?: string) {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (!session) redirect("/login");

  const outboundHeaders = new Headers(init?.headers);
  outboundHeaders.set("Authorization", `Bearer ${session}`);
  const tenantSlug = tenantSlugOverride ?? requestHeaders.get(TENANT_SLUG_HEADER) ?? undefined;
  const tenantId = cookieStore.get(ACTIVE_TENANT_COOKIE)?.value;
  const selectedTenantSlug = cookieStore.get(ACTIVE_TENANT_SLUG_COOKIE)?.value;
  const salonId = cookieStore.get(ACTIVE_SALON_COOKIE)?.value;
  if (tenantSlug) outboundHeaders.set("X-Tenant-Slug", tenantSlug);
  else if (tenantId) outboundHeaders.set("X-Tenant-ID", tenantId);
  if (salonId && (!tenantSlug || selectedTenantSlug === tenantSlug)) outboundHeaders.set("X-Salon-ID", salonId);

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: outboundHeaders,
    cache: "no-store"
  });

  if (response.status === 401) redirect("/login");
  if (response.status === 400 && !tenantId) redirect("/select-tenant");
  return response;
}

export async function backendJson<T>(path: string, init?: RequestInit, tenantSlugOverride?: string): Promise<T> {
  const response = await backendFetch(path, init, tenantSlugOverride);
  if (!response.ok) throw new Error(`${path} request failed: ${response.status}`);
  return (await response.json()) as T;
}
