import { NextResponse, type NextRequest } from "next/server";
import { backendFetch } from "@/lib/backend";
import { rejectCrossOriginMutation } from "@/lib/request-security";

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext) {
  const rejected = rejectCrossOriginMutation(request);
  if (rejected) return rejected;
  const { path } = await context.params;
  const query = request.nextUrl.search;
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const photoMetadata = request.headers.get("x-chart-photo-metadata");
  if (photoMetadata && request.method === "POST" && path.length === 3 && path[0] === "charts" && path[2] === "photos") {
    if (photoMetadata.length > 7000) return NextResponse.json({ message: "写真の記録が長すぎます。" }, { status: 400 });
    headers.set("X-Chart-Photo-Metadata", photoMetadata);
  }

  const response = await backendFetch(`/api/${path.map(encodeURIComponent).join("/")}${query}`, {
    method: request.method,
    headers,
    body
  });
  return new NextResponse(response.body, {
    status: response.status,
    headers: { "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
