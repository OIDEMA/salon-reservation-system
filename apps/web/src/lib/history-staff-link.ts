import type { ReservationHistoryStaffLinkPlan, ReservationHistoryStaffLinkResult } from "./admin-types";
import { tenantApiPath } from "./tenant-routing";

export function canLinkHistoryStaff(tenantSlug: string, can: (permission: string) => boolean) {
  return tenantSlug === "missmrs-takamatsu" && can("master.write") && can("reservation.write") && can("chart.write");
}

async function historyStaffResponse<T>(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message ?? `担当の紐付けを処理できませんでした（${response.status}）。`);
  return body as T;
}

export function prepareHistoryStaffLinks(tenantSlug: string, signal?: AbortSignal) {
  return fetch(tenantApiPath(tenantSlug, "/admin/history-staff-links/prepare"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", cache: "no-store", signal
  }).then(historyStaffResponse<ReservationHistoryStaffLinkPlan>);
}

export function applyHistoryStaffLinks(tenantSlug: string, checksum: string, signal?: AbortSignal) {
  return fetch(tenantApiPath(tenantSlug, "/admin/history-staff-links/apply"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ checksum }), cache: "no-store", signal
  }).then(historyStaffResponse<ReservationHistoryStaffLinkResult>);
}
