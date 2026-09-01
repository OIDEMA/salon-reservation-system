import { NextResponse, type NextRequest } from "next/server";
import { backendFetch } from "@/lib/backend";
import { isTenantSlug } from "@/lib/tenant-routing";

type RouteContext = { params: Promise<{ tenantSlug: string; path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext) {
  const { tenantSlug, path } = await context.params;
  if (!isTenantSlug(tenantSlug)) return NextResponse.json({ message: "Tenant not found" }, { status: 404 });

  const query = request.nextUrl.search;
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  const response = await backendFetch(
    `/api/${path.map(encodeURIComponent).join("/")}${query}`,
    { method: request.method, headers, body },
    tenantSlug
  );
  return new NextResponse(response.body, {
    status: response.status,
    headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" }
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
