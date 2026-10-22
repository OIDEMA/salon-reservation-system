import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/auth/password-status/route";
import { passwordRecoveryFeedback } from "../src/lib/password-recovery";

const origin = "https://reservation.example.test";
function statusRequest(body: unknown, headers: Record<string, string> = { origin }) {
  return new NextRequest(`${origin}/api/auth/password-status`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  });
}

test("password-status returns the same uncached response without account lookups", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Account lookup must not occur"); });
  const responses = [];
  for (const email of ["existing@example.test", "new@example.test", "disabled@example.test", "missing@example.test", " EXISTING@example.test "]) {
    const response = await POST(statusRequest({ email }));
    responses.push({ status: response.status, body: await response.json() });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  for (const response of responses) assert.deepEqual(response, { status: 200, body: { needsPasswordSetup: false } });
  assert.equal(fetch.mock.callCount(), 0);
});

test("password-status keeps input and origin validation", async () => {
  for (const input of [{ email: "not-an-email" }, {}, null]) {
    assert.equal((await POST(statusRequest(input))).status, 400);
  }
  for (const headers of [{ origin: "https://attacker.test" }, { origin: "null" }, {}] as Record<string, string>[]) {
    assert.equal((await POST(statusRequest({ email: "existing@example.test" }, headers))).status, 403);
  }
  const malformed = new NextRequest(`${origin}/api/auth/password-status`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: "{"
  });
  assert.equal((await POST(malformed)).status, 400);
});

test("account recovery feedback does not reveal account existence or disabled status", () => {
  const success = passwordRecoveryFeedback();
  assert.equal(success.tone, "success");
  assert.deepEqual(passwordRecoveryFeedback({ code: "auth/user-not-found" }), success);
  assert.deepEqual(passwordRecoveryFeedback({ code: "auth/user-disabled" }), success);
  assert.match(success.text, /対象のアカウントがある場合/);
});

test("recoverable input and transport errors remain actionable without exposing raw errors", () => {
  for (const code of ["auth/invalid-email", "auth/too-many-requests", "auth/network-request-failed", "unknown"]) {
    const feedback = passwordRecoveryFeedback({ code, message: "sensitive-provider-message" });
    assert.equal(feedback.tone, "error");
    assert.doesNotMatch(feedback.text, /sensitive-provider-message/);
  }
});
