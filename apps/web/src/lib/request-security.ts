import type { NextRequest } from "next/server";

function configuredOrigins() {
  return (process.env.APP_PUBLIC_ORIGINS ?? process.env.APP_PUBLIC_ORIGIN ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    });
}

/**
 * App Hosting can expose an internal request origin through NextRequest.nextUrl.
 * Keep the configured public origin in the allow-list while retaining the
 * request-derived origin for local development and other trusted deployments.
 */
export function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  return new Set([request.nextUrl.origin, ...configuredOrigins()]).has(origin);
}
