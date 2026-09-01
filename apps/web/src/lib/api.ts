import type { DashboardData } from "./types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4001";

export async function fetchDashboard(date: string): Promise<DashboardData> {
  const response = await fetch(`${API_BASE_URL}/api/dashboard?date=${date}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Dashboard request failed: ${response.status}`);
  }

  return (await response.json()) as DashboardData;
}
