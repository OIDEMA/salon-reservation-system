import type { DashboardData, ReservationStatus } from "./types";

export type DashboardPreload = {
  tenantSlug: string;
  data: DashboardData;
};

export type DashboardRequest = {
  tenantSlug: string;
  salonId?: string;
  date: string;
  q: string;
  status: "ALL" | ReservationStatus;
  refreshKey: number;
  canRead: boolean;
  renderId?: string;
};

export function dashboardToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function validDashboardDate(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

export function isDashboardDocumentRequest(headers: Pick<Headers, "get">) {
  return headers.get("sec-fetch-dest") === "document" || Boolean(headers.get("accept")?.includes("text/html"));
}

export function matchingDashboardPreload(preload: DashboardPreload | undefined, request: DashboardRequest) {
  return request.canRead && request.refreshKey === 0 && request.q === "" && request.status === "ALL"
    && preload?.tenantSlug === request.tenantSlug && preload.data.date === request.date
    && preload.data.salon?.id === request.salonId ? preload?.data : undefined;
}

function requestKey(request: DashboardRequest) {
  return JSON.stringify([request.tenantSlug, request.salonId, request.date, request.q, request.status, request.refreshKey, request.canRead, request.renderId]);
}

export function dashboardPreloadState(preload: DashboardPreload | undefined, request: DashboardRequest, hydrating = true) {
  return { preload, requestKey: requestKey(request), invalidated: !hydrating };
}

/** A seed is reusable for repeated mount effects, never after a local request changes. */
export function takeDashboardPreload(state: ReturnType<typeof dashboardPreloadState>, preload: DashboardPreload | undefined, request: DashboardRequest) {
  const nextKey = requestKey(request);
  if (state.preload !== preload || state.requestKey !== nextKey) {
    // Client navigation may replay cached RSC props. Only the original document
    // response can skip the first client fetch; later navigation always refetches.
    state.invalidated = true;
  }
  state.requestKey = nextKey;
  return state.invalidated ? undefined : matchingDashboardPreload(preload, request);
}
