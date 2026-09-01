import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { firebaseAdminAuth } from "@/lib/firebase-admin";
import {
  ACTIVE_SALON_COOKIE,
  ACTIVE_TENANT_COOKIE,
  ACTIVE_TENANT_SLUG_COOKIE,
  CSRF_COOKIE,
  SESSION_COOKIE
} from "@/lib/session-constants";

const sessionSchema = z.object({
  idToken: z.string().min(1),
  csrfToken: z.string().uuid()
});

const expiresIn = 5 * 24 * 60 * 60 * 1000;

function secureCookie(request: NextRequest) {
  return process.env.NODE_ENV === "production" || request.nextUrl.protocol === "https:";
}

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  return !origin || origin === request.nextUrl.origin;
}

export async function GET(request: NextRequest) {
  const csrfToken = randomUUID();
  const response = NextResponse.json({ csrfToken });
  response.cookies.set(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: secureCookie(request),
    sameSite: "strict",
    path: "/",
    maxAge: 10 * 60
  });
  return response;
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "Invalid origin" }, { status: 403 });
  const input = sessionSchema.parse(await request.json());
  if (request.cookies.get(CSRF_COOKIE)?.value !== input.csrfToken) {
    return NextResponse.json({ message: "Invalid CSRF token" }, { status: 403 });
  }

  const claims = await firebaseAdminAuth.verifyIdToken(input.idToken, true);
  if (!claims.email || claims.email_verified !== true) {
    return NextResponse.json({ code: "EMAIL_NOT_VERIFIED", message: "メールアドレスを確認してください。" }, { status: 403 });
  }
  if (Date.now() / 1000 - claims.auth_time > 5 * 60) {
    return NextResponse.json({ message: "再ログインしてください。" }, { status: 401 });
  }

  const sessionCookie = await firebaseAdminAuth.createSessionCookie(input.idToken, { expiresIn });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: secureCookie(request),
    sameSite: "strict",
    path: "/",
    maxAge: expiresIn / 1000
  });
  response.cookies.delete(CSRF_COOKIE);
  response.cookies.delete(ACTIVE_TENANT_COOKIE);
  response.cookies.delete(ACTIVE_TENANT_SLUG_COOKIE);
  response.cookies.delete(ACTIVE_SALON_COOKIE);
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "Invalid origin" }, { status: 403 });
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(ACTIVE_TENANT_COOKIE);
  response.cookies.delete(ACTIVE_TENANT_SLUG_COOKIE);
  response.cookies.delete(ACTIVE_SALON_COOKIE);
  return response;
}
