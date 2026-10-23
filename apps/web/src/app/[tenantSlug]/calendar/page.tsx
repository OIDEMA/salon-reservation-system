import { ReservationCalendar } from "@/components/reservation-calendar";
import { backendJson } from "@/lib/backend";
import { dashboardToday } from "@/lib/dashboard-preload";
import { calendarMonth, type ReservationCalendarData } from "@/lib/reservation-calendar";
import { fetchDashboardServer } from "@/lib/server-dashboard";

export default async function TenantCalendarPage({ params, searchParams }: {
  params: Promise<{ tenantSlug: string }>;
  searchParams?: Promise<{ month?: string | string[] }>;
}) {
  const [{ tenantSlug }, query] = await Promise.all([params, searchParams]);
  const now = new Date();
  const today = dashboardToday(now);
  const month = calendarMonth(query?.month, now);
  const [calendar, dashboard] = await Promise.all([
    backendJson<ReservationCalendarData>(`/api/reservations/calendar?month=${month}`, undefined, tenantSlug),
    fetchDashboardServer(today, tenantSlug)
  ]);

  return <ReservationCalendar calendar={calendar} today={today} todayQueue={dashboard.queue} />;
}
