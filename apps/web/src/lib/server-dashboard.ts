import "server-only";

import { backendJson } from "./backend";
import type { DashboardData } from "./types";

export function fetchDashboardServer(date: string, tenantSlug?: string) {
  return backendJson<DashboardData>(`/api/dashboard?date=${encodeURIComponent(date)}`, undefined, tenantSlug);
}
