import type { NextResponse } from "next/server";
import { ACTIVE_SALON_COOKIE, ACTIVE_TENANT_COOKIE, ACTIVE_TENANT_SLUG_COOKIE } from "./session-constants";
import { isTenantSlug } from "./tenant-routing";

export interface SelectableTenantMembership {
  role?: string; permissions?: string[];
  tenant: { id: string; slug: string; name?: string; salons: { id: string; name?: string }[] };
}
export type AllowedTenantSelection = { tenantId: string; tenantSlug: string; salonId: string };

/** Input is the current API's active memberships, already filtered to allowed salons. */
export function findAllowedTenantSelection(memberships: SelectableTenantMembership[], input: { tenantId?: string; tenantSlug?: string; salonId: string }) {
  if (!input.tenantId && !input.tenantSlug) return null;
  const matches = memberships.filter(({ tenant }) => (!input.tenantId || tenant.id === input.tenantId)
    && (!input.tenantSlug || tenant.slug === input.tenantSlug) && isTenantSlug(tenant.slug)
    && tenant.salons.some((salon) => salon.id === input.salonId));
  if (matches.length !== 1) return null;
  const membership = matches[0];
  return { membership, selection: { tenantId: membership.tenant.id, tenantSlug: membership.tenant.slug, salonId: input.salonId } };
}

/** Call only after revalidating the browser user's membership and allowed salon. */
export function setTenantSelectionCookies(response: NextResponse, selection: AllowedTenantSelection, secure: boolean) {
  const options = { httpOnly: true, secure, sameSite: "strict" as const, path: "/", maxAge: 30 * 24 * 60 * 60 };
  response.cookies.set(ACTIVE_TENANT_COOKIE, selection.tenantId, options);
  response.cookies.set(ACTIVE_TENANT_SLUG_COOKIE, selection.tenantSlug, options);
  response.cookies.set(ACTIVE_SALON_COOKIE, selection.salonId, options);
}
