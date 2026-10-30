import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/staff-handoff/route";
import { proxy } from "../src/proxy";
import { parseStaffHandoff, safeStaffHandoffReturnTo, staffHandoffPath, staffHandoffDestination } from "../src/lib/staff-handoff";
import { findAllowedTenantSelection } from "../src/lib/tenant-selection";

const origin = "https://reservation.example.test";
const input = { tenantSlug: "company-b", salonId: "shop-b", checkoutId: "checkout-b" };
const path = staffHandoffPath(input);
const memberships = [{ role: "STAFF", permissions: ["checkout.read", "checkout.write", "reservation.read"],
  tenant: { id: "tenant-b", slug: "company-b", name: "会社B", salons: [{ id: "shop-b", name: "店舗B" }] } }];
const checkout = { id: "checkout-b", tenantId: "tenant-b", salonId: "shop-b" };
function request(method = "GET", headers: Record<string, string> = {}, url = path) {
  return new NextRequest(`${origin}${url}`, { method, headers: {
    cookie: "__session=browser-session; active_tenant=tenant-a; active_tenant_slug=company-a; active_salon=shop-a", ...headers,
  } });
}

test("handoff accepts only one valid scope and target and cannot become an arbitrary redirect", () => {
  assert.deepEqual(parseStaffHandoff(new URLSearchParams(path.split("?")[1])), input);
  assert.equal(safeStaffHandoffReturnTo(path), path);
  assert.equal(staffHandoffDestination(input), "/company-b/checkout/checkout-b");
  for (const query of ["tenantSlug=company-b&salonId=shop-b", "tenantSlug=company-b&salonId=shop-b&checkoutId=x&reservationId=y",
    "tenantSlug=company-b&salonId=shop-b&checkoutId=x&checkoutId=y", "tenantSlug=company-b&salonId=../other&checkoutId=x",
    "tenantSlug=login&salonId=shop-b&checkoutId=x", "tenantSlug=company-b&salonId=shop-b&checkoutId=x&returnTo=https://attacker.test"]) {
    assert.equal(parseStaffHandoff(new URLSearchParams(query)), null);
  }
  for (const value of ["https://attacker.test", "//attacker.test/path", "/\\attacker.test", "/company-b/checkout/x", `${path}#external`,
    `${path}&token=secret`, `/api/staff-handoff?tenantSlug=company-b&salonId=shop-b&checkoutId=%2f%2fattacker.test`, [path]]) {
    assert.equal(safeStaffHandoffReturnTo(value), null);
  }
});

test("the selected salon must come from the current active membership's allowed salons", () => {
  assert.equal(findAllowedTenantSelection(memberships, input)?.selection.tenantId, "tenant-b");
  assert.equal(findAllowedTenantSelection(memberships, { ...input, salonId: "shop-a" }), null);
  assert.equal(findAllowedTenantSelection(memberships, { ...input, tenantId: "tenant-a" }), null);
  assert.equal(findAllowedTenantSelection([], input), null);
});

test("GET verifies the current browser membership and selected target without changing cookies or business data", async (t) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Response.json(String(url).endsWith("/tenants") ? memberships : checkout); });
  const response = await GET(request()); const body = await response.text();
  assert.equal(response.status, 200); assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(body, /会社B/); assert.match(body, /店舗B/); assert.match(body, /method="post"/); assert.match(body, /この店舗の会計を開く/);
  assert.doesNotMatch(body, /tenant-a|shop-a|browser-session|<script/);
  assert.equal(calls.length, 2);
  const initialHeaders = new Headers(calls[0].init?.headers);
  assert.equal(initialHeaders.get("Authorization"), "Bearer browser-session"); assert.equal(initialHeaders.has("X-Tenant-Slug"), false);
  const targetHeaders = new Headers(calls[1].init?.headers);
  assert.equal(targetHeaders.get("X-Tenant-Slug"), "company-b"); assert.equal(targetHeaders.get("X-Salon-ID"), "shop-b");
  for (const { init, url } of calls) { assert.ok(!init?.method || init.method === "GET"); assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit"); assert.doesNotMatch(url, /browser-session|token|Bearer/); }
});

test("confirmed same-origin POST switches all UI scope cookies before redirecting to the fixed internal checkout", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(String(url).endsWith("/tenants") ? memberships : checkout));
  const response = await POST(request("POST", { origin }));
  assert.equal(response.status, 303); assert.equal(response.headers.get("location"), "/company-b/checkout/checkout-b");
  assert.equal(response.cookies.get("active_tenant")?.value, "tenant-b"); assert.equal(response.cookies.get("active_tenant_slug")?.value, "company-b"); assert.equal(response.cookies.get("active_salon")?.value, "shop-b");
  for (const cookie of response.cookies.getAll()) { assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, "strict"); assert.equal(cookie.path, "/"); }
});

test("cross-origin and missing-origin posts cannot read membership or change selection", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call"); });
  for (const headers of [{ origin: "https://attacker.test" }, { origin: "null" }, {}] as Record<string, string>[]) {
    const response = await POST(request("POST", headers)); assert.equal(response.status, 403); assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("login retains only the validated internal handoff and an expired browser session cannot loop", async (t) => {
  const noSession = await GET(request("GET", { cookie: "" }));
  assert.equal(noSession.status, 303); assert.equal(noSession.headers.get("location"), `/login?returnTo=${encodeURIComponent(path)}`);
  t.mock.method(globalThis, "fetch", async () => Response.json({ internal: "private details" }, { status: 401 }));
  const expired = await GET(request()); assert.equal(expired.status, 303); assert.equal(expired.cookies.get("__session")?.value, "");
  assert.equal(expired.headers.get("location"), `/login?returnTo=${encodeURIComponent(path)}`);
  const loggedIn = proxy(request("GET", {}, `/login?returnTo=${encodeURIComponent(path)}`));
  assert.equal(loggedIn.headers.get("location"), `${origin}${path}`);
  assert.equal(proxy(request("GET", {}, "/login?returnTo=https://attacker.test")).headers.get("location"), `${origin}/select-tenant`);
});

test("membership removal, restricted salons and other-company checkouts fail before any selection cookie is written", async (t) => {
  for (const value of [[], [{ ...memberships[0], tenant: { ...memberships[0].tenant, salons: [] } }], [{ ...memberships[0], permissions: [] }]]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(value));
    const response = await POST(request("POST", { origin })); assert.equal(response.status, 403); assert.equal(response.headers.get("set-cookie"), null);
  }
  for (const wrong of [{ ...checkout, tenantId: "tenant-a" }, { ...checkout, salonId: "shop-a" }, { ...checkout, id: "checkout-a" }]) {
    t.mock.method(globalThis, "fetch", async (url: string) => Response.json(String(url).endsWith("/tenants") ? memberships : wrong));
    const response = await POST(request("POST", { origin })); assert.equal(response.status, 404); assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("POST revalidates memberships after the confirmation page, so revoked access cannot be reused", async (t) => {
  let active = true;
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(String(url).endsWith("/tenants") ? active ? memberships : [] : checkout));
  assert.equal((await GET(request())).status, 200); active = false;
  const response = await POST(request("POST", { origin })); assert.equal(response.status, 403); assert.equal(response.headers.get("set-cookie"), null);
});

test("reservation handoff checks creation/read permissions and never creates a checkout", async (t) => {
  const reservationPath = staffHandoffPath({ tenantSlug: "company-b", salonId: "shop-b", reservationId: "reservation-b" });
  let requestCount = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => { requestCount++; assert.ok(!init?.method || init.method === "GET"); return Response.json(String(url).endsWith("/tenants") ? memberships : { id: "reservation-b" }); });
  const response = await POST(request("POST", { origin }, reservationPath));
  assert.equal(response.status, 303); assert.equal(response.headers.get("location"), "/company-b/checkout/new?reservationId=reservation-b"); assert.equal(requestCount, 2);
  t.mock.method(globalThis, "fetch", async () => Response.json([{ ...memberships[0], permissions: ["checkout.read"] }]));
  assert.equal((await POST(request("POST", { origin }, reservationPath))).status, 403);
});

test("unavailable/malformed upstream data does not expose private diagnostics, and store names are escaped", async (t) => {
  for (const response of [Response.json({ secret: "private-diagnostic" }, { status: 503 }), Response.json({ invalid: true }), new Response("not-json")]) {
    t.mock.method(globalThis, "fetch", async () => response);
    const result = await GET(request()); assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /private-diagnostic|not-json/); assert.equal(result.headers.get("set-cookie"), null);
  }
  t.mock.method(globalThis, "fetch", async (url: string) => Response.json(String(url).endsWith("/tenants") ? [{ ...memberships[0], tenant: { ...memberships[0].tenant, name: "<script>alert(1)</script>" } }] : checkout));
  assert.match(await (await GET(request())).text(), /&lt;script&gt;/);
});
