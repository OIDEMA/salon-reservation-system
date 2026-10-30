import { isTenantSlug } from "./tenant-routing";

export type StaffHandoff = { tenantSlug: string; salonId: string } & (
  { checkoutId: string; reservationId?: never } | { checkoutId?: never; reservationId: string }
);
const identifier = /^[A-Za-z0-9_-]{1,160}$/;
const route = "/api/staff-handoff";

/** A handoff contains scope and one accounting target, never a free redirect URL. */
export function parseStaffHandoff(query: URLSearchParams): StaffHandoff | null {
  const allowed = new Set(["tenantSlug", "salonId", "checkoutId", "reservationId"]);
  for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) return null;
  const tenantSlug = query.get("tenantSlug") ?? "";
  const salonId = query.get("salonId") ?? "";
  const checkoutId = query.get("checkoutId"), reservationId = query.get("reservationId");
  if (!isTenantSlug(tenantSlug) || !identifier.test(salonId) || Boolean(checkoutId) === Boolean(reservationId)) return null;
  if (checkoutId !== null && reservationId !== null) return null;
  if (checkoutId && identifier.test(checkoutId)) return { tenantSlug, salonId, checkoutId };
  if (reservationId && identifier.test(reservationId)) return { tenantSlug, salonId, reservationId };
  return null;
}

export function staffHandoffPath(input: StaffHandoff) {
  const query = new URLSearchParams({ tenantSlug: input.tenantSlug, salonId: input.salonId,
    ...(input.checkoutId ? { checkoutId: input.checkoutId } : { reservationId: input.reservationId! }) });
  return `${route}?${query}`;
}

/** Only the known, fully validated handoff can survive a login. */
export function safeStaffHandoffReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 700 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  const base = "https://handoff.invalid";
  try {
    const url = new URL(value, base);
    if (url.origin !== base || url.pathname !== route || url.hash) return null;
    const input = parseStaffHandoff(url.searchParams);
    return input ? staffHandoffPath(input) : null;
  } catch { return null; }
}

export function staffHandoffDestination(input: StaffHandoff) {
  return input.checkoutId
    ? `/${encodeURIComponent(input.tenantSlug)}/checkout/${encodeURIComponent(input.checkoutId)}`
    : `/${encodeURIComponent(input.tenantSlug)}/checkout/new?reservationId=${encodeURIComponent(input.reservationId!)}`;
}
