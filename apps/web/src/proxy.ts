import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-constants";
import { isTenantSlug, TENANT_SLUG_HEADER } from "@/lib/tenant-routing";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/brand/") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (pathname === "/login") {
    return hasSession ? NextResponse.redirect(new URL("/select-tenant", request.url)) : NextResponse.next();
  }
  if (pathname === "/select-tenant") {
    return hasSession ? NextResponse.next() : NextResponse.redirect(new URL("/login", request.url));
  }
  if (!hasSession) return NextResponse.redirect(new URL("/login", request.url));
  if (pathname === "/") return NextResponse.redirect(new URL("/select-tenant", request.url));

  const encodedTenantSlug = pathname.split("/")[1] ?? "";
  let tenantSlug = "";
  try {
    tenantSlug = decodeURIComponent(encodedTenantSlug);
  } catch {
    return NextResponse.redirect(new URL("/select-tenant", request.url));
  }
  if (!isTenantSlug(tenantSlug)) return NextResponse.redirect(new URL("/select-tenant", request.url));

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(TENANT_SLUG_HEADER, tenantSlug);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|brand).*)"]
};
