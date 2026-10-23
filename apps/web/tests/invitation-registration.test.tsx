import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/invitations/[action]/route";
import { invitationErrors, invitationTokenFromHash, InvitationRequestError, previewInvitation, registerInvitation, validateInvitationRegistration } from "../src/lib/invitation-registration";
import { createBrowserSession, loginFailureMessage, SessionRequestError } from "../src/lib/login-session";
import { InvitationRegistrationForm } from "../src/components/invitation-registration-form";

const origin = "https://reservation.example.test";
const token = "a".repeat(43);
const tenant = { id: "tenant-test", slug: "salon-test", name: "招待テスト店舗" };
const preview = { email: "invited@example.test", tenant, role: "STAFF" as const, alreadyRegistered: false };
const fields = { token, displayName: " 招待スタッフ ", password: " secure password ", confirmation: " secure password " };
const context = (action: string) => ({ params: Promise.resolve({ action }) });
const request = (body: unknown = { token }, headers: Record<string, string> = { origin }) => new NextRequest(`${origin}/api/invitations/preview`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
});

test("public invitation proxy permits only same-origin preview/register and never forwards credentials", async (t) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json(String(url).endsWith("/preview") ? { ...preview, internal: "not-public" } : { registered: true, tenant, secret: "not-public" });
  });
  const response = await POST(request({ token }, { origin, cookie: "session=must-not-forward", authorization: "Bearer must-not-forward" }), context("preview"));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), preview);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(new URL(calls[0].url).pathname, "/api/access/invitations/preview");
  assert.equal(new URL(calls[0].url).search, "");
  assert.deepEqual(calls[0].init?.headers, { "Content-Type": "application/json" });
  assert.equal(calls[0].init?.redirect, "error"); assert.equal(calls[0].init?.cache, "no-store");
  const registration = await POST(request({ token, displayName: fields.displayName, password: fields.password }), context("register"));
  assert.equal(registration.status, 201); assert.deepEqual(await registration.json(), { registered: true, tenant });
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { token, displayName: "招待スタッフ", password: fields.password });
  for (const action of ["accept", "../access", "register/other", "constructor"]) assert.equal((await POST(request(), context(action))).status, 404);
  for (const header of [{}, { origin: "https://attacker.test" }, { origin: "null" }] as Record<string, string>[]) assert.equal((await POST(request({ token }, header), context("register"))).status, 403);
  assert.equal(calls.length, 2);
});

test("public invitation proxy rejects malformed, oversized and extra-field requests without contacting API", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not contact API"); });
  for (const body of [null, {}, { token: "invalid" }, { token, extra: "forbidden" }]) assert.equal((await POST(request(body), context("preview"))).status, 400);
  for (const body of [{ token, displayName: " ", password: "12345678" }, { token, displayName: "a\nb", password: "12345678" },
    { token, displayName: "a", password: "short" }, { token, displayName: "a", password: "p".repeat(129) },
    { token, displayName: "a", password: "12345678", email: "another@example.test" }]) assert.equal((await POST(request(body), context("register"))).status, 400);
  assert.equal((await POST(request({ token }, { origin, "content-type": "text/plain" }), context("preview"))).status, 400);
  assert.equal((await POST(request({ token }, { origin, "content-length": "8193" }), context("preview"))).status, 413);
  assert.equal((await POST(request({ token: "a".repeat(9000) }), context("preview"))).status, 413);
  const malformed = new NextRequest(`${origin}/api/invitations/preview`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{" });
  assert.equal((await POST(malformed, context("preview"))).status, 400);
  assert.equal(upstream.mock.callCount(), 0);
});

test("proxy returns only known safe errors and validates successful response payloads", async (t) => {
  for (const [code, expected] of Object.entries(invitationErrors)) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ code, message: "secret-provider-message", token }, { status: expected.status }));
    const response = await POST(request({ token }), context("preview"));
    assert.equal(response.status, expected.status); assert.deepEqual(await response.json(), { code, message: expected.message });
  }
  for (const value of [Response.json({ code: "UNEXPECTED", message: "secret-provider-message" }, { status: 500 }),
    Response.json({ email: preview.email }), Response.json({ ...preview, tenant: { ...tenant, slug: "//attacker.test" } }), new Response("not-json")]) {
    t.mock.method(globalThis, "fetch", async () => value);
    const response = await POST(request(), context("preview"));
    assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(await response.json()), /secret-provider-message|attacker/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret-transport-error"); });
  assert.equal((await POST(request(), context("preview"))).status, 503);
});

test("registration validation preserves password spaces, checks confirmation, and sends only the invitation identity", async (t) => {
  assert.deepEqual(validateInvitationRegistration(fields), { token, displayName: "招待スタッフ", password: fields.password });
  assert.throws(() => validateInvitationRegistration({ ...fields, confirmation: "different" }), /一致しません/);
  let count = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    count++; assert.equal(url, "/api/invitations/register");
    assert.deepEqual(JSON.parse(String(init.body)), { token, displayName: "招待スタッフ", password: fields.password });
    assert.equal(init.cache, "no-store"); assert.equal(init.credentials, "same-origin");
    return Response.json({ registered: true, tenant }, { status: 201 });
  });
  await assert.rejects(registerInvitation({ ...fields, confirmation: "different" }), /一致しません/); assert.equal(count, 0);
  assert.deepEqual(await registerInvitation(fields), { registered: true, tenant }); assert.equal(count, 1);
});

test("invitation token stays in fragment and preview/register failures do not expose raw responses", async (t) => {
  assert.equal(invitationTokenFromHash(`#token=${token}`), token);
  for (const value of ["", "#token=invalid", "#token=%3Cscript%3E", "#next=https://attacker.test"]) assert.equal(invitationTokenFromHash(value), "");
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "/api/invitations/preview"); assert.deepEqual(JSON.parse(String(init.body)), { token }); return Response.json(preview);
  });
  assert.deepEqual(await previewInvitation(token), preview);
  t.mock.method(globalThis, "fetch", async () => Response.json({ code: "INVITATION_ACCOUNT_EXISTS", message: "private provider data" }, { status: 409 }));
  await assert.rejects(registerInvitation(fields), (error: unknown) => error instanceof InvitationRequestError && error.code === "INVITATION_ACCOUNT_EXISTS" && !error.message.includes("private provider data"));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private network details"); });
  await assert.rejects(registerInvitation(fields), (error: unknown) => error instanceof InvitationRequestError && error.code === "INVITATION_REGISTRATION_UNAVAILABLE");
});

test("registration uses the same CSRF exchange as login and never posts an invalid CSRF token", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const csrfToken = "11111111-1111-4111-8111-111111111111";
  const fakeFetch: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json(init?.method === "POST" ? { ok: true } : { csrfToken }); };
  await createBrowserSession("firebase-id-token", fakeFetch);
  assert.equal(calls.length, 2); assert.equal(calls[0].url, "/api/session"); assert.equal(calls[0].init?.cache, "no-store");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { idToken: "firebase-id-token", csrfToken });
  let invalidCalls = 0;
  await assert.rejects(createBrowserSession("token", async () => { invalidCalls++; return Response.json({ csrfToken: "not-uuid" }); }), SessionRequestError);
  assert.equal(invalidCalls, 1);
  await assert.rejects(createBrowserSession("token", async (_url, init) => init?.method === "POST" ? Response.json({ code: "EMAIL_NOT_VERIFIED", message: "private data" }, { status: 403 }) : Response.json({ csrfToken })), /メールアドレスの確認/);
  assert.doesNotMatch(loginFailureMessage({ code: "unknown", message: "private data" }), /private data/);
});

test("registration form fixes the invited email and offers name, two new-password fields and visible-password control", () => {
  const html = renderToStaticMarkup(createElement(InvitationRegistrationForm, { token, invitation: preview, onExistingAccount: () => {}, onRecoveryLogin: async () => {} }));
  assert.match(html, /readOnly=""[^>]*value="invited@example.test"/);
  assert.match(html, /お名前/); assert.match(html, /パスワード（確認）/);
  assert.equal((html.match(/autoComplete="new-password"/g) ?? []).length, 2);
  assert.match(html, /aria-label="パスワードを表示"/); assert.match(html, /アカウントを登録してログイン/);
  assert.doesNotMatch(html, new RegExp(token));
});
