import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { firebaseAdminAuth } from "../src/auth.js";
import { prisma } from "../src/database.js";
import { registerCurrentUserRoutes } from "../src/current-user-routes.js";

test("current user returns only the authenticated profile and never caches it", async (t) => {
  const app = Fastify();
  registerCurrentUserRoutes(app);
  let disabled = false;
  let revoked = false;
  let userReads = 0;
  const session = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string, checkRevoked?: boolean) => {
    assert.equal(credential, "profile-session");
    assert.equal(checkRevoked, true);
    if (revoked) throw new Error("revoked");
    return { uid: "profile-uid", email: "user@example.test", email_verified: true, name: "表示ユーザー",
      firebase: { sign_in_provider: "password" } } as any;
  });
  const token = t.mock.method(firebaseAdminAuth, "verifyIdToken", async () => { throw new Error("invalid token"); });
  const originalUpsert = prisma.appUser.upsert;
  prisma.appUser.upsert = (async () => {
    userReads++;
    return { id: "private-user-id", firebaseUid: "profile-uid", displayName: "表示ユーザー", email: "user@example.test", disabled };
  }) as typeof prisma.appUser.upsert;
  t.after(async () => {
    prisma.appUser.upsert = originalUpsert;
    session.mock.restore();
    token.mock.restore();
    await app.close();
  });

  const unauthenticated = await app.inject({ url: "/api/me" });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.headers["cache-control"], "private, no-store");
  assert.equal(userReads, 0);

  const headers = { authorization: "Bearer profile-session" };
  const authenticated = await app.inject({ url: "/api/me", headers });
  assert.equal(authenticated.statusCode, 200, authenticated.body);
  assert.equal(authenticated.headers["cache-control"], "private, no-store");
  assert.deepEqual(authenticated.json(), { displayName: "表示ユーザー", email: "user@example.test" });
  assert.equal(userReads, 1);

  disabled = true;
  const disabledResponse = await app.inject({ url: "/api/me", headers });
  assert.equal(disabledResponse.statusCode, 403);
  assert.equal(disabledResponse.json().code, "USER_DISABLED");
  assert.equal(disabledResponse.headers["cache-control"], "private, no-store");
  assert(!disabledResponse.body.includes("user@example.test"));

  disabled = false;
  revoked = true;
  const revokedResponse = await app.inject({ url: "/api/me", headers });
  assert.equal(revokedResponse.statusCode, 401);
  assert.equal(revokedResponse.headers["cache-control"], "private, no-store");
  assert.equal(userReads, 2);
});
