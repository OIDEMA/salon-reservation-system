import "server-only";

import { backendJson } from "./backend";
import type { DashboardData } from "./types";

export function fetchDashboardServer(date: string) {
  return backendJson<DashboardData>(`/api/dashboard?date=${date}`);
}
