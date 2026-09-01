import type { DashboardData } from "./types";

export async function fetchDashboard(date: string): Promise<DashboardData> {
  const response = await fetch(`/api/backend/dashboard?date=${date}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Dashboard request failed: ${response.status}`);
  }

  return (await response.json()) as DashboardData;
}
