import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { backendJson } from "@/lib/backend";
import { ACTIVE_SALON_COOKIE, ACTIVE_TENANT_COOKIE, ACTIVE_TENANT_SLUG_COOKIE } from "@/lib/session-constants";
import { isTenantSlug } from "@/lib/tenant-routing";
import { sameOrigin } from "@/lib/request-security";

const selectionSchema = z.object({ tenantId: z.string().min(1), salonId: z.string().min(1) });
type Membership = { tenant: { id: string; slug: string; salons: Array<{ id: string }> } };

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "Invalid origin" }, { status: 403 });
  const input = selectionSchema.parse(await request.json());
  const memberships = await backendJson<Membership[]>("/api/me/tenants");
  const selectedMembership = memberships.find(
    (membership) => membership.tenant.id === input.tenantId && membership.tenant.salons.some((salon) => salon.id === input.salonId)
  );
  if (!selectedMembership) return NextResponse.json({ message: "Tenant access denied" }, { status: 403 });
  if (!isTenantSlug(selectedMembership.tenant.slug)) {
    return NextResponse.json({ message: "Tenant URL is not configured" }, { status: 409 });
  }

  const response = NextResponse.json({ ok: true, tenantSlug: selectedMembership.tenant.slug });
  const secure = process.env.NODE_ENV === "production" || request.nextUrl.protocol === "https:";
  response.cookies.set(ACTIVE_TENANT_COOKIE, input.tenantId, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: 30 * 24 * 60 * 60 });
  response.cookies.set(ACTIVE_TENANT_SLUG_COOKIE, selectedMembership.tenant.slug, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: 30 * 24 * 60 * 60
  });
  response.cookies.set(ACTIVE_SALON_COOKIE, input.salonId, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: 30 * 24 * 60 * 60 });
  return response;
}
