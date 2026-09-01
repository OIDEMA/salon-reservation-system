import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { backendJson } from "@/lib/backend";
import { ACTIVE_SALON_COOKIE, ACTIVE_TENANT_COOKIE } from "@/lib/session-constants";

const selectionSchema = z.object({ tenantId: z.string().min(1), salonId: z.string().min(1) });
type Membership = { tenant: { id: string; salons: Array<{ id: string }> } };

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({ message: "Invalid origin" }, { status: 403 });
  const input = selectionSchema.parse(await request.json());
  const memberships = await backendJson<Membership[]>("/api/me/tenants");
  const allowed = memberships.some(
    (membership) => membership.tenant.id === input.tenantId && membership.tenant.salons.some((salon) => salon.id === input.salonId)
  );
  if (!allowed) return NextResponse.json({ message: "Tenant access denied" }, { status: 403 });

  const response = NextResponse.json({ ok: true });
  const secure = process.env.NODE_ENV === "production" || request.nextUrl.protocol === "https:";
  response.cookies.set(ACTIVE_TENANT_COOKIE, input.tenantId, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: 30 * 24 * 60 * 60 });
  response.cookies.set(ACTIVE_SALON_COOKIE, input.salonId, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: 30 * 24 * 60 * 60 });
  return response;
}
