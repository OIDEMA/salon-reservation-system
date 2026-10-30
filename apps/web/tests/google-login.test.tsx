import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginForm, type LoginFormProps } from "../src/components/login-form";
import { loginFailureMessage, loginWithBrowserSession, SessionRequestError } from "../src/lib/login-session";
import { createDefaultRealmSessionCookie, FirebaseRealmError } from "../src/lib/browser-session-cookie";

const csrfToken = "00000000-0000-4000-8000-000000000001";
function fixture(options: { verified?: boolean; failSession?: boolean } = {}) {
  const events: string[] = [], requests: Array<{ url: string; init?: RequestInit }> = [];
  const credential = { user: { emailVerified: options.verified !== false, getIdToken: async (force: boolean) => {
    assert.equal(force, true); events.push("firebase-id-token"); return "verified-firebase-id-token";
  } }, providerId: "google.com", rawGoogleIdToken: "must-not-send-provider-token", email: "private@example.test" };
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (init?.method === "POST") {
      events.push("session-post");
      return options.failSession ? Response.json({ code: "USER_DISABLED", message: "private diagnostics" }, { status: 403 }) : new Response(null, { status: 204 });
    }
    events.push("csrf-get"); return Response.json({ csrfToken });
  };
  const clear = async () => { events.push("sign-out"); };
  return { events, requests, credential, request: request as typeof fetch, clear };
}

test("Google and password credentials use the same verified Firebase token and CSRF session exchange", async () => {
  for (const providerId of ["google.com", "password"]) {
    const f = fixture();
    await loginWithBrowserSession(async () => { f.events.push("sign-in"); return { ...f.credential, providerId }; }, f.clear, f.request);
    assert.deepEqual(f.events.slice(0, 4), ["sign-in", "firebase-id-token", "csrf-get", "session-post"]);
    assert(f.events.slice(4).length >= 1 && f.events.slice(4).every((event) => event === "sign-out"));
    assert.deepEqual(f.requests.map((item) => item.url), ["/api/session", "/api/session"]);
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { idToken: "verified-firebase-id-token", csrfToken });
    for (const item of f.requests) { assert.equal(item.init?.cache, "no-store"); assert.equal(item.init?.credentials, "same-origin"); }
    assert(!JSON.stringify(f.requests).includes("must-not-send-provider-token"));
    assert(!JSON.stringify(f.requests).includes("private@example.test"));
  }
});

test("popup cancellation and provider collisions stop before token/session requests and clear SDK state", async () => {
  for (const code of ["auth/popup-closed-by-user", "auth/cancelled-popup-request", "auth/account-exists-with-different-credential", "auth/credential-already-in-use"]) {
    const f = fixture(), problem = { code, email: "private@example.test", credential: "must-not-use" };
    await assert.rejects(loginWithBrowserSession(async () => { throw problem; }, f.clear, f.request), (error) => error === problem);
    assert.deepEqual(f.events, ["sign-out"]); assert.equal(f.requests.length, 0);
    const message = loginFailureMessage(problem, "google"); assert(!message.includes(problem.email)); assert(!message.includes(problem.credential));
  }
});

test("unverified Google or password identities cannot create a browser cookie", async () => {
  const f = fixture({ verified: false });
  await assert.rejects(loginWithBrowserSession(async () => f.credential, f.clear, f.request), (error) => error instanceof SessionRequestError && /メールアドレスの確認/.test(error.message));
  assert.deepEqual(f.events, ["sign-out"]); assert.equal(f.requests.length, 0);
});

test("a colliding UID in another Firebase realm cannot mint a browser session for Google or password", async () => {
  for (const provider of ["google.com", "password"]) {
    for (const tenant of [undefined, ""]) {
      let calls = 0;
      const claims = { uid: "same-project-colliding-uid", firebase: { sign_in_provider: provider, tenant } };
      assert.equal(await createDefaultRealmSessionCookie(claims, async () => { calls++; return "verified-default-session"; }), "verified-default-session");
      assert.equal(calls, 1);
    }
    for (const tenant of ["foreign-auth-realm", "salon-db-tenant", " ", null, {}, [], false, 0]) {
      let calls = 0;
      const claims = { uid: "same-project-colliding-uid", firebase: { sign_in_provider: provider, tenant } };
      await assert.rejects(createDefaultRealmSessionCookie(claims, async () => { calls++; return "must-not-mint"; }), (error) =>
        error instanceof FirebaseRealmError && !error.message.includes(claims.uid) && !error.message.includes("foreign-auth-realm"));
      assert.equal(calls, 0);
    }
  }
});

test("failed cookie creation clears Firebase state without returning private API diagnostics", async () => {
  const f = fixture({ failSession: true });
  await assert.rejects(loginWithBrowserSession(async () => f.credential, f.clear, f.request), (error) => error instanceof SessionRequestError && /無効/.test(error.message) && !error.message.includes("private"));
  assert.equal(f.events.at(-1), "sign-out"); assert.equal(f.events.filter((item) => item === "session-post").length, 1);
});

test("Firebase cleanup is attempted even if readiness or token retrieval fails", async () => {
  const f = fixture();
  const problem = new Error("private token failure");
  await assert.rejects(loginWithBrowserSession(async () => ({ user: { emailVerified: true, getIdToken: async () => { throw problem; } } }), f.clear, f.request), (error) => error === problem);
  assert.equal(f.requests.length, 0); assert.deepEqual(f.events, ["sign-out"]);
  await assert.rejects(loginWithBrowserSession(async () => { throw problem; }, async () => { throw new Error("cleanup failed"); }, f.request), (error) => error === problem);
});

test("Google errors are safe and password error messages retain their existing behavior", () => {
  assert.match(loginFailureMessage({ code: "auth/popup-closed-by-user" }, "google"), /キャンセル/);
  assert.match(loginFailureMessage({ code: "auth/popup-blocked" }, "google"), /ポップアップ/);
  assert.match(loginFailureMessage({ code: "auth/account-exists-with-different-credential" }, "google"), /既存の方法/);
  assert.match(loginFailureMessage({ code: "auth/operation-not-allowed" }, "google"), /Google/);
  assert.match(loginFailureMessage({ code: "auth/unauthorized-domain" }, "google"), /管理者/);
  assert.match(loginFailureMessage({ code: "auth/invalid-credential" }, "google"), /Googleログイン/);
  assert.equal(loginFailureMessage({ code: "auth/wrong-password" }), "メールアドレスまたはパスワードが正しくありません。");
  assert.equal(loginFailureMessage({ code: "auth/operation-not-allowed" }), "メールアドレスとパスワードによるログインは現在利用できません。");
  assert(!loginFailureMessage(new Error("private token or email"), "google").includes("private"));
});

test("Google button does not submit the required password form; email login and recovery remain available", () => {
  const html = renderToStaticMarkup(createElement<LoginFormProps>(LoginForm, { initialEmail: "staff@example.test", returnTo: "https://attacker.test" }));
  assert.match(html, /class="authGoogle" type="button"/); assert.match(html, /Googleでログイン/); assert.match(html, /brand%2Fgoogle-g.png|brand\/google-g.png/);
  assert.match(html, /type="email"[^>]*value="staff@example.test"/); assert.match(html, /autoComplete="current-password"/);
  assert.match(html, /class="authSubmit" type="submit"/); assert.match(html, /href="\/password-reset"/);
  assert(!html.includes("attacker.test"));
});
