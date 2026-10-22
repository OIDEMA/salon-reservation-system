import { NextResponse, type NextRequest } from "next/server";

function httpOrigin(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

function configuredOrigins() {
  return (process.env.APP_PUBLIC_ORIGINS ?? process.env.APP_PUBLIC_ORIGIN ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => httpOrigin(value) ?? []);
}

/**
 * App Hosting can expose an internal request origin through NextRequest.nextUrl.
 * Keep the configured public origin in the allow-list while retaining the
 * request-derived origin for local development and other trusted deployments.
 */
export function sameOrigin(request: NextRequest) {
  const allowed = new Set([request.nextUrl.origin, ...configuredOrigins()]);
  const origin = request.headers.get("origin");
  // A supplied Origin is authoritative, including the opaque "null" origin.
  if (origin !== null) return origin !== "null" && allowed.has(origin);

  // Some same-origin clients omit Origin. Require browser evidence instead of
  // accepting a missing header; SameSite cookies alone do not isolate subdomains.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;
  const referer = request.headers.get("referer");
  if (referer !== null) {
    const refererOrigin = httpOrigin(referer);
    return refererOrigin !== null && allowed.has(refererOrigin);
  }
  return fetchSite === "same-origin";
}

/** Apply before reading or forwarding the body of a cookie-authenticated proxy. */
export function rejectCrossOriginMutation(request: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || sameOrigin(request)) return null;
  return NextResponse.json(
    { code: "INVALID_ORIGIN", message: "アクセス元が正しくありません。" },
    { status: 403 }
  );
}
