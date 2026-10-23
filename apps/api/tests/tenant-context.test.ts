import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Fastify, { type FastifyRequest } from "fastify";
import { firebaseAdminAuth } from "../src/auth.js";
import { prisma } from "../src/database.js";
import { requirePermission } from "../src/permissions.js";
import { requireAuthenticatedUser, requireTenantContext, requestedSalonId } from "../src/tenant-context.js";

/** No database or Firebase network calls: count the actual guard's dependencies. */
function fixture(t: TestContext) {
  const state = {
    revoked: false, verified: true, disabled: false,
    membershipStatus: "ACTIVE", tenantStatus: "ACTIVE", salonIds: ["salon-a"]
  };
  const counts = { firebase: 0, user: 0, membership: 0, salon: 0 };
  const session = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string, revoked?: boolean) => {
    counts.firebase++; assert.equal(revoked, true);
    if (state.revoked || credential !== "synthetic-session") throw new Error("revoked credential");
    return { uid: "synthetic-user", email: "synthetic@example.test", email_verified: state.verified };
  });
  const idToken = t.mock.method(firebaseAdminAuth, "verifyIdToken", async (_credential: string, revoked?: boolean) => {
    assert.equal(revoked, true); throw new Error("invalid ID token");
  });
  // Prisma delegates are dynamic proxies without method descriptors, so restore
  // their assigned functions explicitly instead of using mock.method.
  const original = { user: prisma.appUser.upsert, membership: prisma.tenantMembership.findFirst,
    membershipId: prisma.tenantMembership.findUnique, salon: prisma.salon.findFirst };
  prisma.appUser.upsert = (async () => {
    counts.user++;
    return { id: "synthetic-user", disabled: state.disabled };
  }) as typeof prisma.appUser.upsert;
  function membership() {
    return { tenantId: "tenant-a", userId: "synthetic-user", role: "STAFF", status: state.membershipStatus,
      salonIds: [...state.salonIds], useCustomPermissions: true, permissions: ["reservation.read"],
      tenant: { id: "tenant-a", slug: "synthetic", status: state.tenantStatus } };
  }
  prisma.tenantMembership.findFirst = (async (args: any) => {
    counts.membership++;
    return args.where.tenant.slug === "synthetic" ? membership() : null;
  }) as typeof prisma.tenantMembership.findFirst;
  prisma.tenantMembership.findUnique = (async (args: any) => {
    counts.membership++;
    return args.where.tenantId_userId.tenantId === "tenant-a" ? membership() : null;
  }) as typeof prisma.tenantMembership.findUnique;
  prisma.salon.findFirst = (async (args: any) => {
    counts.salon++;
    const selected = typeof args.where.id === "string" ? args.where.id : args.where.id?.in?.[0] ?? "salon-a";
    return ["salon-a", "salon-b"].includes(selected) ? { id: selected, tenantId: "tenant-a" } : null;
  }) as typeof prisma.salon.findFirst;
  t.after(() => {
    prisma.appUser.upsert = original.user;
    prisma.tenantMembership.findFirst = original.membership;
    prisma.tenantMembership.findUnique = original.membershipId;
    prisma.salon.findFirst = original.salon;
    session.mock.restore(); idToken.mock.restore();
  });
  const headers = { authorization: "Bearer synthetic-session", "x-tenant-slug": "synthetic" };
  function app(handler?: (request: FastifyRequest) => void, roles?: Array<"OWNER" | "STAFF">) {
    const server = Fastify({ logger: false });
    server.addHook("preHandler", async (request, reply) => { await requirePermission(request, reply, "reservation.read"); });
    server.get("/page", async (request, reply) => {
      handler?.(request);
      const context = await requireTenantContext(request, reply, roles);
      return context ? { tenantId: context.tenant.id, salonId: requestedSalonId(request) } : undefined;
    });
    t.after(() => server.close());
    return server;
  }
  return { state, counts, headers, app };
}

test("tenant guards reuse successful checks only within the current HTTP request", async (t) => {
  await t.test("the permission hook and handler verify Firebase and database scope once, including implicit salon normalization", async (t) => {
    const f = fixture(t), app = f.app();
    const first = await app.inject({ url: "/page", headers: f.headers });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { tenantId: "tenant-a", salonId: "salon-a" });
    assert.deepEqual(f.counts, { firebase: 1, user: 1, membership: 1, salon: 1 });
    const second = await app.inject({ url: "/page", headers: f.headers });
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(f.counts, { firebase: 2, user: 2, membership: 2, salon: 2 });
  });

  await t.test("a handler's stricter roles are checked after a successful permission hook", async (t) => {
    const f = fixture(t), app = f.app(undefined, ["OWNER"]);
    const response = await app.inject({ url: "/page", headers: f.headers });
    assert.equal(response.statusCode, 403); assert.equal(response.json().code, "ROLE_ACCESS_DENIED");
    assert.deepEqual(f.counts, { firebase: 1, user: 1, membership: 1, salon: 1 });
  });

  await t.test("a second permission check cannot reuse a weaker permission grant", async (t) => {
    const f = fixture(t), app = Fastify({ logger: false }); t.after(() => app.close());
    app.addHook("preHandler", async (request, reply) => { await requirePermission(request, reply, "reservation.read"); });
    app.get("/page", async (request, reply) => {
      const context = await requirePermission(request, reply, "access.manage");
      return context ? { allowed: true } : undefined;
    });
    const response = await app.inject({ url: "/page", headers: f.headers });
    assert.equal(response.statusCode, 403); assert.equal(response.json().code, "PERMISSION_DENIED");
    assert.deepEqual(f.counts, { firebase: 1, user: 1, membership: 1, salon: 1 });
  });

  await t.test("changing the authorization header invalidates the earlier identity and scope", async (t) => {
    const f = fixture(t), app = f.app((request) => { request.headers.authorization = "Bearer invalid-session"; });
    const response = await app.inject({ url: "/page", headers: f.headers });
    assert.equal(response.statusCode, 401); assert.equal(response.json().code, "UNAUTHENTICATED");
    assert.deepEqual(f.counts, { firebase: 2, user: 1, membership: 1, salon: 1 });
  });

  await t.test("a failed credential change discards the earlier identity even after restoring the original header", async (t) => {
    const f = fixture(t), app = Fastify({ logger: false }); t.after(() => app.close());
    app.addHook("preHandler", async (request, reply) => { await requirePermission(request, reply, "reservation.read"); });
    app.get("/page", async (request, reply) => {
      const denied = { code(status: number) { assert.equal(status, 401); return this; },
        send(payload: { code: string }) { assert.equal(payload.code, "UNAUTHENTICATED"); } };
      request.headers.authorization = "Bearer invalid-session";
      assert.equal(await requireTenantContext(request, denied as any), null);
      request.headers.authorization = f.headers.authorization;
      f.state.disabled = true;
      const context = await requireTenantContext(request, reply);
      return context ? { allowed: true } : undefined;
    });
    const response = await app.inject({ url: "/page", headers: f.headers });
    assert.equal(response.statusCode, 403); assert.equal(response.json().code, "USER_DISABLED");
    assert.deepEqual(f.counts, { firebase: 3, user: 2, membership: 1, salon: 1 });
  });

  await t.test("a credential changed during verification cannot cache or grant the earlier identity", async (t) => {
    const f = fixture(t), app = Fastify({ logger: false }); t.after(() => app.close());
    app.get("/page", async (request, reply) => {
      const pending = requireAuthenticatedUser(request, reply);
      request.headers.authorization = "Bearer different-session";
      return await pending ? { allowed: true } : undefined;
    });
    const response = await app.inject({ url: "/page", headers: f.headers });
    assert.equal(response.statusCode, 401); assert.equal(response.json().code, "UNAUTHENTICATED");
  });

  for (const field of ["x-tenant-slug", "x-tenant-id"] as const) {
    await t.test(`changing ${field} resolves the tenant again and rejects an inaccessible tenant`, async (t) => {
      const f = fixture(t), app = f.app((request) => {
        if (field === "x-tenant-id") delete request.headers["x-tenant-slug"];
        request.headers[field] = "foreign-tenant";
      });
      const response = await app.inject({ url: "/page", headers: f.headers });
      assert.equal(response.statusCode, 403); assert.equal(response.json().code, "TENANT_ACCESS_DENIED");
      assert.deepEqual(f.counts, { firebase: 1, user: 1, membership: 2, salon: 1 });
    });
  }

  await t.test("a changed salon is reauthorized and cannot retain the earlier salon's grant", async (t) => {
    const f = fixture(t), app = f.app((request) => { request.headers["x-salon-id"] = "salon-b"; });
    const response = await app.inject({ url: "/page", headers: f.headers });
    assert.equal(response.statusCode, 403); assert.equal(response.json().code, "SALON_ACCESS_DENIED");
    assert.deepEqual(f.counts, { firebase: 1, user: 1, membership: 2, salon: 2 });
  });

  await t.test("a permitted salon switch returns its newly resolved scope", async (t) => {
    const f = fixture(t); f.state.salonIds = ["salon-a", "salon-b"];
    const app = f.app((request) => { request.headers["x-salon-id"] = "salon-b"; });
    const response = await app.inject({ url: "/page", headers: f.headers });
    assert.equal(response.statusCode, 200); assert.equal(response.json().salonId, "salon-b");
    assert.deepEqual(f.counts, { firebase: 1, user: 1, membership: 2, salon: 2 });
  });

  await t.test("a failed scope change discards the earlier success even after restoring the original header", async (t) => {
    const f = fixture(t), app = Fastify({ logger: false }); t.after(() => app.close());
    app.addHook("preHandler", async (request, reply) => { await requirePermission(request, reply, "reservation.read"); });
    app.get("/page", async (request, reply) => {
      // Capture a failed check without sending the real HTTP response, so this
      // test can simulate middleware restoring its original scope afterwards.
      const denied = { code(status: number) { assert.equal(status, 403); return this; },
        send(payload: { code: string }) { assert.equal(payload.code, "TENANT_ACCESS_DENIED"); } };
      request.headers["x-tenant-slug"] = "foreign-tenant";
      assert.equal(await requireTenantContext(request, denied as any), null);
      request.headers["x-tenant-slug"] = "synthetic";
      f.state.membershipStatus = "SUSPENDED";
      const context = await requireTenantContext(request, reply);
      return context ? { allowed: true } : undefined;
    });
    const response = await app.inject({ url: "/page", headers: f.headers });
    assert.equal(response.statusCode, 403); assert.equal(response.json().code, "TENANT_ACCESS_DENIED");
    assert.deepEqual(f.counts, { firebase: 1, user: 1, membership: 3, salon: 1 });
  });

  for (const [label, update, code] of [
    ["Firebase revocation", (f: ReturnType<typeof fixture>) => { f.state.revoked = true; }, "UNAUTHENTICATED"],
    ["unverified email", (f: ReturnType<typeof fixture>) => { f.state.verified = false; }, "EMAIL_NOT_VERIFIED"],
    ["disabled application user", (f: ReturnType<typeof fixture>) => { f.state.disabled = true; }, "USER_DISABLED"],
    ["suspended membership", (f: ReturnType<typeof fixture>) => { f.state.membershipStatus = "SUSPENDED"; }, "TENANT_ACCESS_DENIED"],
    ["suspended tenant", (f: ReturnType<typeof fixture>) => { f.state.tenantStatus = "SUSPENDED"; }, "TENANT_ACCESS_DENIED"],
    ["removed salon access", (f: ReturnType<typeof fixture>) => { f.state.salonIds = ["salon-b"]; }, "SALON_ACCESS_DENIED"]
  ] as const) {
    await t.test(`the next HTTP request immediately observes ${label}`, async (t) => {
      const f = fixture(t), app = f.app();
      const headers = { ...f.headers, "x-salon-id": "salon-a" };
      assert.equal((await app.inject({ url: "/page", headers })).statusCode, 200);
      update(f);
      const denied = await app.inject({ url: "/page", headers });
      assert.equal(denied.statusCode, code === "UNAUTHENTICATED" ? 401 : 403, denied.body);
      assert.equal(denied.json().code, code); assert.equal(f.counts.firebase, 2);
    });
  }

  await t.test("direct authentication plus tenant resolution still performs one identity check per request", async (t) => {
    const f = fixture(t), app = Fastify({ logger: false }); t.after(() => app.close());
    app.get("/page", async (request, reply) => {
      if (!await requireAuthenticatedUser(request, reply)) return;
      const context = await requireTenantContext(request, reply);
      return context ? { allowed: true } : undefined;
    });
    assert.equal((await app.inject({ url: "/page", headers: f.headers })).statusCode, 200);
    assert.deepEqual(f.counts, { firebase: 1, user: 1, membership: 1, salon: 1 });
  });
});
