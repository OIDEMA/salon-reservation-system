import type { DashboardData, ReservationStatus } from "./types";
import { tenantApiPath } from "./tenant-routing";

export type DashboardFilters = { q: string; status: "ALL" | ReservationStatus };

export async function fetchDashboard(date: string, tenantSlug: string, filters?: DashboardFilters, signal?: AbortSignal): Promise<DashboardData> {
  const query = new URLSearchParams({ date });
  if (filters?.q.trim()) query.set("q", filters.q.trim());
  if (filters?.status && filters.status !== "ALL") query.set("status", filters.status);
  const response = await fetch(`${tenantApiPath(tenantSlug, "/dashboard")}?${query}`, {
    cache: "no-store", signal
  });

  if (!response.ok) {
    throw new Error(`Dashboard request failed: ${response.status}`);
  }

  return (await response.json()) as DashboardData;
}
