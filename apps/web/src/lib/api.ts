import type { DashboardData } from "./types";
import { tenantApiPath } from "./tenant-routing";

export async function fetchDashboard(date: string, tenantSlug: string): Promise<DashboardData> {
  const response = await fetch(`${tenantApiPath(tenantSlug, "/dashboard")}?date=${date}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Dashboard request failed: ${response.status}`);
  }

  return (await response.json()) as DashboardData;
}
