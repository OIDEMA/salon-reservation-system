import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { backendJson } from "@/lib/backend";
import { sameOrigin } from "@/lib/request-security";
import { isTenantSlug } from "@/lib/tenant-routing";
import { setTenantSelectionCookies, type SelectableTenantMembership } from "@/lib/tenant-selection";

const selectionSchema = z.object({ tenantId: z.string().min(1), salonId: z.string().min(1) });

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "Invalid origin" }, { status: 403 });
  const input = selectionSchema.parse(await request.json());
  const memberships = await backendJson<SelectableTenantMembership[]>("/api/me/tenants");
  const selectedMembership = memberships.find(
    (membership) => membership.tenant.id === input.tenantId && membership.tenant.salons.some((salon) => salon.id === input.salonId)
  );
  if (!selectedMembership) return NextResponse.json({ message: "Tenant access denied" }, { status: 403 });
  if (!isTenantSlug(selectedMembership.tenant.slug)) {
    return NextResponse.json({ message: "Tenant URL is not configured" }, { status: 409 });
  }

  const response = NextResponse.json({ ok: true, tenantSlug: selectedMembership.tenant.slug });
  const secure = process.env.NODE_ENV === "production" || request.nextUrl.protocol === "https:";
  setTenantSelectionCookies(response, { tenantId: input.tenantId, tenantSlug: selectedMembership.tenant.slug, salonId: input.salonId }, secure);
  return response;
}
