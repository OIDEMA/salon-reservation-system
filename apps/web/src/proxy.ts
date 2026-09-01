import { NextResponse, type NextRequest } from "next/server";
import { ACTIVE_TENANT_COOKIE, SESSION_COOKIE } from "@/lib/session-constants";

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
  if (!hasSession) return NextResponse.redirect(new URL("/login", request.url));
  if (pathname !== "/select-tenant" && !request.cookies.get(ACTIVE_TENANT_COOKIE)?.value) {
    return NextResponse.redirect(new URL("/select-tenant", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|brand).*)"]
};
