import { NextResponse, type NextRequest } from "next/server";
import { sameOrigin } from "@/lib/request-security";
import { ACTIVE_SALON_COOKIE, ACTIVE_TENANT_COOKIE, ACTIVE_TENANT_SLUG_COOKIE, SESSION_COOKIE } from "@/lib/session-constants";
import { parseStaffHandoff, staffHandoffDestination, staffHandoffPath, type StaffHandoff } from "@/lib/staff-handoff";
import { findAllowedTenantSelection, setTenantSelectionCookies, type SelectableTenantMembership } from "@/lib/tenant-selection";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4001";
const privateHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
class HandoffError extends Error { constructor(public status: number, message: string) { super(message); } }

function html(title: string, content: string, status = 200) {
  return new NextResponse(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:0;font:16px/1.8 system-ui,sans-serif;color:#171717;background:#fff}main{max-width:420px;margin:10vh auto;padding:28px}img{display:block;max-width:85%;height:auto;margin:0 auto 42px}h1{font-size:24px;line-height:1.5}p{color:#666}button,a{font:inherit}button{width:100%;background:#171717;color:white;border:0;padding:15px;margin-top:20px;cursor:pointer}a{color:#333}small{color:#777}</style></head><body><main><img src="/brand/beauty-gum-wordmark.webp" width="308" height="70" alt="BeautyGum"><h1>${escape(title)}</h1>${content}</main></body></html>`, {
    status, headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}
function login(request: NextRequest, input: StaffHandoff) {
  const response = new NextResponse(null, { status: 303, headers: { ...privateHeaders, Location: `/login?returnTo=${encodeURIComponent(staffHandoffPath(input))}` } });
  // An expired cookie must not bounce from /login back to the same rejected session.
  if (request.cookies.has(SESSION_COOKIE)) {
    for (const name of [SESSION_COOKIE, ACTIVE_TENANT_COOKIE, ACTIVE_TENANT_SLUG_COOKIE, ACTIVE_SALON_COOKIE]) response.cookies.delete(name);
  }
  return response;
}
function readMemberships(value: unknown): SelectableTenantMembership[] {
  if (!Array.isArray(value)) throw new HandoffError(503, "所属店舗を確認できませんでした。もう一度お試しください。");
  for (const item of value) {
    if (!item || typeof item !== "object" || !item.tenant || typeof item.tenant.id !== "string" || typeof item.tenant.slug !== "string"
      || typeof item.tenant.name !== "string" || item.tenant.name.length > 2000 || !Array.isArray(item.permissions) || !item.permissions.every((entry: unknown) => typeof entry === "string")
      || !Array.isArray(item.tenant.salons) || !item.tenant.salons.every((salon: unknown) => salon && typeof salon === "object" && "id" in salon && typeof salon.id === "string" && "name" in salon && typeof salon.name === "string" && salon.name.length <= 2000)) {
      throw new HandoffError(503, "所属店舗を確認できませんでした。もう一度お試しください。");
    }
  }
  return value as SelectableTenantMembership[];
}
async function authorizedSelection(request: NextRequest, input: StaffHandoff) {
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session) throw new HandoffError(401, "ログインしてください。");
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  async function read(path: string, scoped: boolean) {
    const headers = new Headers({ Authorization: `Bearer ${session}` });
    if (scoped) { headers.set("X-Tenant-Slug", input.tenantSlug); headers.set("X-Salon-ID", input.salonId); }
    const response = await fetch(`${apiBaseUrl}${path}`, { headers, signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error" });
    if (response.status === 401) throw new HandoffError(401, "ログインしてください。");
    if (response.status === 403) throw new HandoffError(403, "この店舗の会計を開く権限がありません。店舗の管理者にお問い合わせください。");
    if (response.status === 404) throw new HandoffError(404, "指定した店舗の会計・予約が見つかりません。アプリから選び直してください。");
    if (!response.ok || response.redirected) throw new HandoffError(503, "店舗の情報を確認できませんでした。もう一度お試しください。");
    return response.json() as Promise<unknown>;
  }
  try {
    // The old browser selection is intentionally not forwarded to the membership lookup.
    const memberships = readMemberships(await read("/api/me/tenants", false));
    const allowed = findAllowedTenantSelection(memberships, input);
    if (!allowed) throw new HandoffError(403, "指定した会社・店舗を利用できません。店舗の管理者に所属をご確認ください。");
    const can = (permission: string) => allowed.membership.role === "OWNER" || allowed.membership.permissions?.includes(permission);
    if (!can("checkout.read") || (input.reservationId && (!can("checkout.write") || !can("reservation.read")))) {
      throw new HandoffError(403, "この店舗の会計を開く権限がありません。店舗の管理者にお問い合わせください。");
    }
    const target = await read(input.checkoutId ? `/api/cash/checkouts/${encodeURIComponent(input.checkoutId)}` : `/api/reservations/${encodeURIComponent(input.reservationId!)}`, true);
    if (!target || typeof target !== "object" || !("id" in target) || target.id !== (input.checkoutId ?? input.reservationId)
      || (input.checkoutId && (!("tenantId" in target) || target.tenantId !== allowed.selection.tenantId || !("salonId" in target) || target.salonId !== input.salonId))) {
      throw new HandoffError(404, "指定した店舗の会計・予約が見つかりません。アプリから選び直してください。");
    }
    return allowed;
  } finally { clearTimeout(timeout); }
}
async function handoff(request: NextRequest, update: boolean) {
  if (update && !sameOrigin(request)) return html("会計を開けません", "<p>アクセス元を確認できませんでした。アプリからもう一度開いてください。</p>", 403);
  const input = parseStaffHandoff(request.nextUrl.searchParams);
  if (!input) return html("会計を開けません", "<p>会計の指定が正しくありません。アプリから選び直してください。</p>", 400);
  try {
    const allowed = await authorizedSelection(request, input);
    if (!update) {
      const salon = allowed.membership.tenant.salons.find((item) => item.id === input.salonId)!;
      return html("会計を開く店舗を確認", `<p>${escape(allowed.membership.tenant.name!)}<br><strong>${escape(salon.name!)}</strong></p><p>このブラウザで利用する店舗を切り替えて、${input.checkoutId ? "選択した会計" : "会計の開始画面"}を開きます。</p><form method="post" action="${escape(staffHandoffPath(input))}"><button type="submit">この店舗の会計を開く</button></form><p><small>ポイントや会計の内容は、この操作では変更されません。</small></p>`);
    }
    const response = new NextResponse(null, { status: 303, headers: { ...privateHeaders, Location: staffHandoffDestination(input) } });
    setTenantSelectionCookies(response, allowed.selection, process.env.NODE_ENV === "production" || request.nextUrl.protocol === "https:");
    return response;
  } catch (problem) {
    if (problem instanceof HandoffError && problem.status === 401) return login(request, input);
    return html("会計を開けません", `<p>${escape(problem instanceof HandoffError ? problem.message : "店舗の情報を確認できませんでした。通信を確認して、アプリからもう一度開いてください。")}</p>`, problem instanceof HandoffError ? problem.status : 503);
  }
}

export const GET = (request: NextRequest) => handoff(request, false);
export const POST = (request: NextRequest) => handoff(request, true);
