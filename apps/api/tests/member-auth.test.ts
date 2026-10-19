import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { firebaseAdminAuth } from "../src/auth.js";
import { requireMemberIdentity } from "../src/member-auth.js";
import { registerMemberBookingRoutes } from "../src/member-booking-routes.js";

const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJtZW1iZXIifQ.signature";
const claims = { uid: "verified-member", aud: "salon-reserve-bg", iss: "https://securetoken.google.com/salon-reserve-bg", email: "member@example.test", email_verified: true,
  firebase: { sign_in_provider: "password", identities: {} } };

test("member authentication accepts only verified Firebase ID token with revocation checking; never session cookie", async (t) => {
  const app = Fastify(); let current: any = claims; let calls = 0;
  const sessions = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async () => { throw new Error("Must never run"); });
  const tokens = t.mock.method(firebaseAdminAuth, "verifyIdToken", async (value: string, revoked?: boolean) => { assert.equal(value, token); assert.equal(revoked, true); calls++; if (current instanceof Error) throw current; return current; });
  app.get("/identity", async (request, reply) => { const identity = await requireMemberIdentity(request, reply); return identity ?? undefined; });
  try {
    for (const authorization of [undefined, "Basic abc", `Bearer ${token} extra`, `Bearer ${"x".repeat(9000)}`, "Bearer not-a-jwt"]) {
      const response = await app.inject({ url: "/identity", headers: authorization ? { authorization } : {} }); assert.equal(response.statusCode, 401);
    }
    assert.equal(calls, 0);
    const valid = await app.inject({ url: "/identity", headers: { authorization: `Bearer ${token}` } }); assert.equal(valid.statusCode, 200); assert.deepEqual(valid.json(), { projectId: "salon-reserve-bg", uid: claims.uid });
    for (const invalid of [{ ...claims, aud: "other" }, { ...claims, iss: "https://session.firebase.google.com/salon-reserve-bg" },
      { ...claims, firebase: { sign_in_provider: "anonymous" } }, { ...claims, email_verified: false }]) {
      current = invalid; assert.equal((await app.inject({ url: "/identity", headers: { authorization: `Bearer ${token}` } })).statusCode, 403);
    }
    current = { ...claims, email: undefined, email_verified: undefined, phone_number: "+819012345678", firebase: { sign_in_provider: "phone" } };
    assert.equal((await app.inject({ url: "/identity", headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
    current = new Error("revoked or disabled"); assert.equal((await app.inject({ url: "/identity", headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    assert.equal(sessions.mock.callCount(), 0);
  } finally { await app.close(); tokens.mock.restore(); sessions.mock.restore(); }
});
test("every member endpoint rejects missing credential before any database access", async () => {
  const app = Fastify(); const db = new Proxy({}, { get() { throw new Error("Must not read database without authentication"); } });
  registerMemberBookingRoutes(app, { database: db as any });
  for (const [method, url] of [["GET", "/api/member/catalog"], ["GET", "/api/member/availability"], ["GET", "/api/member/reservations"], ["POST", "/api/member/reservations"], ["POST", "/api/member/reservations/foreign/cancel"]] as const) {
    const response = await app.inject({ method, url, ...(method === "POST" ? { payload: {} } : {}) });
    assert.equal(response.statusCode, 401, response.body); assert.equal(response.headers["cache-control"], "private, no-store"); assert(!response.body.includes("database"));
  }
  await app.close();
});
