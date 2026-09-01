import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_SALON_COOKIE, ACTIVE_TENANT_COOKIE, SESSION_COOKIE } from "./session-constants";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4001";

export async function backendFetch(path: string, init?: RequestInit) {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (!session) redirect("/login");

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${session}`);
  const tenantId = cookieStore.get(ACTIVE_TENANT_COOKIE)?.value;
  const salonId = cookieStore.get(ACTIVE_SALON_COOKIE)?.value;
  if (tenantId) headers.set("X-Tenant-ID", tenantId);
  if (salonId) headers.set("X-Salon-ID", salonId);

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store"
  });

  if (response.status === 401) redirect("/login");
  if (response.status === 400 && !tenantId) redirect("/select-tenant");
  return response;
}

export async function backendJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await backendFetch(path, init);
  if (!response.ok) throw new Error(`${path} request failed: ${response.status}`);
  return (await response.json()) as T;
}
