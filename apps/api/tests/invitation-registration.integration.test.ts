import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { CreateRequest, UserRecord } from "firebase-admin/auth";
import Fastify, { type FastifyInstance } from "fastify";
import type { RegistrationAuth } from "../src/invitation-registration.js";
import { deriveInvitationToken } from "../src/invitation-token.js";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
if (testDatabaseUrl && !new URL(testDatabaseUrl).pathname.endsWith("_test")) {
  throw new Error("Invitation registration integration tests require an explicit database name ending in _test.");
}

const password = "  integration-only-password  ";
const authError = (code: string) => Object.assign(new Error(code), { code });

/** A local Firebase substitute with atomic email uniqueness and injectable post-create failures. */
function fakeAuth(createdUids: Set<string>, afterCreate?: (user: UserRecord) => Promise<void>) {
  const users = new Map<string, UserRecord>();
  const requests: CreateRequest[] = [];
  function seed(email: string, uid = `existing-${randomUUID()}`) {
    const user = { uid, email, emailVerified: true, disabled: false, displayName: "Existing identity" } as UserRecord;
    users.set(uid, user);
    return user;
  }
  const auth: RegistrationAuth = {
    async getUser(uid) {
      const user = users.get(uid);
      if (!user) throw authError("auth/user-not-found");
      return user;
    },
    async getUserByEmail(email) {
      const user = [...users.values()].find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());
      if (!user) throw authError("auth/user-not-found");
      return user;
    },
    async createUser(input) {
      requests.push(input);
      assert(input.uid && input.email, "registration must bind a generated UID to the invitation email");
      if ([...users.values()].some((user) => user.email?.toLowerCase() === input.email!.toLowerCase())) {
        throw authError("auth/email-already-exists");
      }
      const user = { uid: input.uid, email: input.email, emailVerified: input.emailVerified,
        disabled: input.disabled, displayName: input.displayName } as UserRecord;
      users.set(user.uid, user);
      createdUids.add(user.uid);
      await afterCreate?.(user);
      return user;
    }
  };
  return { auth, users, requests, seed };
}

/** Fail only the final transaction, after the normal preflight transaction. */
function failFinalTransaction(database: PrismaClient, mode: "rollback" | "lost-commit") {
  let transactions = 0;
  return new Proxy(database, {
    get(target, property) {
      if (property === "$transaction") return async (
        operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: { maxWait?: number; timeout?: number }
      ) => {
        transactions++;
        if (transactions !== 2) return target.$transaction(operation, options);
        if (mode === "rollback") return target.$transaction(async (tx) => {
          await operation(tx);
          throw new Error("synthetic final transaction rollback");
        }, options);
        await target.$transaction(operation, options);
        throw new Error("synthetic lost commit acknowledgement");
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

test("invitation registration uses real PostgreSQL with isolated Firebase identities", { skip: !testDatabaseUrl }, async (t) => {
  process.env.DATABASE_URL = testDatabaseUrl!;
  const previousKey = process.env.INVITATION_TOKEN_KEY;
  process.env.INVITATION_TOKEN_KEY = "integration-test-invitation-token-key-32-bytes";
  const [{ prisma }, { registerInvitationRegistrationRoutes }, { registerAccessRoutes }] = await Promise.all([
    import("../src/database.js"), import("../src/invitation-registration.js"), import("../src/access-routes.js")
  ]);
  const prefix = `invitation-register-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const createdUids = new Set<string>();
  const apps: FastifyInstance[] = [];
  let fixtureNumber = 0;

  function appFor(auth: RegistrationAuth, options: { database?: PrismaClient; now?: () => number } = {}) {
    const app = Fastify({ logger: false });
    registerInvitationRegistrationRoutes(app, { auth, database: options.database ?? prisma, now: options.now });
    apps.push(app);
    return app;
  }
  async function fixture(label: string, email?: string) {
    const name = `${prefix}-${++fixtureNumber}-${label}`;
    const owner = await prisma.appUser.create({ data: {
      firebaseUid: `${name}-owner`, email: `${name}-owner@example.test`, displayName: "Invitation owner"
    } });
    userIds.push(owner.id);
    const tenant = await prisma.tenant.create({ data: { slug: name, name: `Registration fixture ${label}` } });
    tenantIds.push(tenant.id);
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Test salon" } });
    await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: owner.id, role: "OWNER" } });
    const source = { id: randomUUID(), email: email ?? `${name}@example.test`, expiresAt: new Date(Date.now() + 86_400_000) };
    const token = deriveInvitationToken(source);
    const invitation = await prisma.tenantInvitation.create({ data: {
      ...source, tenantId: tenant.id, invitedByUserId: owner.id, role: "STAFF", useCustomPermissions: true,
      permissions: ["reservation.read"], salonIds: [salon.id], tokenHash: createHash("sha256").update(token).digest("hex")
    } });
    return { owner, tenant, salon, invitation, token, email: source.email };
  }
  const preview = (app: FastifyInstance, token: string) => app.inject({
    method: "POST", url: "/api/access/invitations/preview", payload: { token }
  });
  const register = (app: FastifyInstance, token: string) => app.inject({
    method: "POST", url: "/api/access/invitations/register", payload: { token, displayName: "  新しいスタッフ  ", password }
  });
  async function noRegistration(f: Awaited<ReturnType<typeof fixture>>) {
    assert.equal(await prisma.tenantMembership.count({ where: { tenantId: f.tenant.id, userId: { not: f.owner.id } } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { tenantId: f.tenant.id, action: "access.invitation.register" } }), 0);
    assert.equal((await prisma.tenantInvitation.findUniqueOrThrow({ where: { id: f.invitation.id } })).acceptedAt, null);
  }

  try {
    await t.test("new registration fixes identity and grants exactly the invitation permissions once", async () => {
      const f = await fixture("success");
      const identity = fakeAuth(createdUids);
      const app = appFor(identity.auth);
      const before = await preview(app, f.token);
      assert.equal(before.statusCode, 200, before.body);
      assert.deepEqual(before.json(), { email: f.email, tenant: { id: f.tenant.id, slug: f.tenant.slug, name: f.tenant.name }, role: "STAFF", alreadyRegistered: false });
      assert.equal(before.headers["cache-control"], "no-store");
      const result = await register(app, f.token);
      assert.equal(result.statusCode, 201, result.body);
      assert.deepEqual(result.json(), { registered: true, tenant: { id: f.tenant.id, slug: f.tenant.slug, name: f.tenant.name } });
      assert.equal(result.headers["cache-control"], "no-store");
      assert.equal(identity.requests.length, 1);
      assert.equal(identity.requests[0].email, f.email);
      assert.equal(identity.requests[0].displayName, "新しいスタッフ");
      assert.equal(identity.requests[0].password, password, "password whitespace must remain unchanged");
      assert.equal(identity.requests[0].emailVerified, true);
      assert.equal(identity.requests[0].disabled, false);
      assert.match(identity.requests[0].uid!, /^invite-/);
      const user = await prisma.appUser.findUniqueOrThrow({ where: { email: f.email } });
      const membership = await prisma.tenantMembership.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: f.tenant.id, userId: user.id } } });
      assert.equal(user.firebaseUid, identity.requests[0].uid);
      assert.equal(membership.role, "STAFF");
      assert.equal(membership.status, "ACTIVE");
      assert.equal(membership.useCustomPermissions, true);
      assert.deepEqual(membership.permissions, ["reservation.read"]);
      assert.deepEqual(membership.salonIds, [f.salon.id]);
      const audits = await prisma.auditLog.findMany({ where: { tenantId: f.tenant.id, resourceId: f.invitation.id } });
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, "access.invitation.register");
      assert.equal(audits[0].actorUserId, user.id);
      assert(!JSON.stringify(audits).includes(f.token));
      assert(!JSON.stringify(audits).includes(password));
      assert.equal((await register(app, f.token)).statusCode, 410);
      assert.equal((await preview(app, f.token)).statusCode, 410);
      assert.equal(identity.requests.length, 1);
    });

    await t.test("existing Firebase and case-insensitive database email owners are never changed", async () => {
      for (const source of ["firebase", "database"] as const) {
        const f = await fixture(source);
        const identity = fakeAuth(createdUids);
        const original = source === "firebase" ? identity.seed(f.email) : await prisma.appUser.create({ data: {
          firebaseUid: `legacy-${randomUUID()}`, email: f.email.toUpperCase(), displayName: "Preserve existing name", disabled: true
        } });
        if ("id" in original) userIds.push(original.id);
        const snapshot = JSON.stringify(original);
        const app = appFor(identity.auth);
        assert.equal((await preview(app, f.token)).json().alreadyRegistered, true);
        const result = await register(app, f.token);
        assert.equal(result.statusCode, 409, result.body);
        assert.equal(result.json().code, "INVITATION_ACCOUNT_EXISTS");
        assert.equal(identity.requests.length, 0);
        const unchanged = "id" in original ? await prisma.appUser.findUniqueOrThrow({ where: { id: original.id } }) : identity.users.get(original.uid);
        assert.equal(JSON.stringify(unchanged), snapshot);
        await noRegistration(f);
      }
    });

    await t.test("Firebase creation followed by a timeout is recovered only through the requested UID", async () => {
      const f = await fixture("firebase-timeout");
      const identity = fakeAuth(createdUids, async () => { throw new Error("synthetic Firebase response lost"); });
      const result = await register(appFor(identity.auth), f.token);
      assert.equal(result.statusCode, 201, result.body);
      assert.equal(identity.users.size, 1);
      assert.equal(identity.requests.length, 1);
      const user = await prisma.appUser.findUniqueOrThrow({ where: { email: f.email } });
      assert.equal(user.firebaseUid, identity.requests[0].uid);
    });

    await t.test("revocation or reduced sender authority after Firebase creation never grants database access", async () => {
      for (const change of ["revoke", "sender-permissions"] as const) {
        const f = await fixture(change);
        const identity = fakeAuth(createdUids, async () => {
          if (change === "revoke") await prisma.tenantInvitation.update({ where: { id: f.invitation.id }, data: { revokedAt: new Date() } });
          else await prisma.tenantMembership.update({ where: { tenantId_userId: { tenantId: f.tenant.id, userId: f.owner.id } },
            data: { role: "STAFF", useCustomPermissions: true, permissions: ["reservation.read"], salonIds: [f.salon.id] } });
        });
        const result = await register(appFor(identity.auth), f.token);
        assert.equal(result.statusCode, 410, result.body);
        assert.equal(result.json().code, "INVITATION_UNAVAILABLE");
        assert.equal(identity.users.size, 1, "keep the Firebase identity for a future valid invitation");
        assert.equal(await prisma.appUser.count({ where: { email: f.email } }), 0);
        await noRegistration(f);
      }
    });

    await t.test("a first login creating this UID before commit reuses the user without rewriting its profile", async () => {
      const f = await fixture("first-login");
      const signedInAt = new Date("2026-01-01T00:00:00.000Z");
      let existingId = "";
      const identity = fakeAuth(createdUids, async (user) => {
        const existing = await prisma.appUser.create({ data: { firebaseUid: user.uid, email: f.email,
          displayName: "先行ログインの表示名", lastSignedInAt: signedInAt } });
        existingId = existing.id;
      });
      const result = await register(appFor(identity.auth), f.token);
      assert.equal(result.statusCode, 201, result.body);
      const user = await prisma.appUser.findUniqueOrThrow({ where: { id: existingId } });
      assert.equal(user.displayName, "先行ログインの表示名");
      assert.deepEqual(user.lastSignedInAt, signedInAt);
      assert.equal(await prisma.appUser.count({ where: { email: f.email } }), 1);
      assert.equal(await prisma.tenantMembership.count({ where: { tenantId: f.tenant.id, userId: user.id } }), 1);
    });

    await t.test("rolled-back registration preserves the Firebase account for ordinary login and invitation acceptance", async () => {
      const f = await fixture("sql-rollback");
      const identity = fakeAuth(createdUids);
      const app = appFor(identity.auth, { database: failFinalTransaction(prisma, "rollback") });
      const result = await register(app, f.token);
      assert.equal(result.statusCode, 503, result.body);
      assert.equal(result.json().code, "INVITATION_REGISTRATION_UNAVAILABLE");
      assert(!result.body.includes(password));
      assert(!result.body.includes(f.token));
      assert.equal(identity.users.size, 1);
      await noRegistration(f);
      assert.equal(await prisma.appUser.count({ where: { email: f.email } }), 0);
      assert.equal((await preview(app, f.token)).json().alreadyRegistered, true);
      assert.equal((await register(app, f.token)).statusCode, 409);
      assert.equal(identity.requests.length, 1);

      // The normal login establishes this verified identity; use the existing
      // authenticated accept endpoint, without creating another Firebase account.
      const firebaseUser = [...identity.users.values()][0];
      const acceptance = Fastify({ logger: false });
      apps.push(acceptance);
      acceptance.setErrorHandler((error, _request, reply) => {
        const failure = error as { statusCode?: number; code?: string };
        return reply.code(failure.statusCode ?? 500).send({ code: failure.code });
      });
      registerAccessRoutes(acceptance, { database: prisma, authenticate: async () => prisma.appUser.upsert({
        where: { firebaseUid: firebaseUser.uid }, update: {}, create: { firebaseUid: firebaseUser.uid, email: f.email, displayName: "Authenticated user" }
      }) });
      const accepted = await acceptance.inject({ method: "POST", url: "/api/access/invitations/accept", payload: { token: f.token } });
      assert.equal(accepted.statusCode, 200, accepted.body);
      const user = await prisma.appUser.findUniqueOrThrow({ where: { firebaseUid: firebaseUser.uid } });
      assert.equal(await prisma.tenantMembership.count({ where: { tenantId: f.tenant.id, userId: user.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { tenantId: f.tenant.id, action: "access.invitation.accept", resourceId: f.invitation.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { tenantId: f.tenant.id, action: "access.invitation.register" } }), 0);
      assert.equal(identity.requests.length, 1);
    });

    await t.test("a committed registration with a lost SQL acknowledgement is confirmed by its exact audit", async () => {
      const f = await fixture("lost-commit");
      const identity = fakeAuth(createdUids);
      const result = await register(appFor(identity.auth, { database: failFinalTransaction(prisma, "lost-commit") }), f.token);
      assert.equal(result.statusCode, 201, result.body);
      assert.equal(result.json().registered, true);
      const user = await prisma.appUser.findUniqueOrThrow({ where: { email: f.email } });
      assert.equal(await prisma.tenantMembership.count({ where: { tenantId: f.tenant.id, userId: user.id } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { tenantId: f.tenant.id, actorUserId: user.id,
        action: "access.invitation.register", resource: "tenantInvitation", resourceId: f.invitation.id } }), 1);
      assert((await prisma.tenantInvitation.findUniqueOrThrow({ where: { id: f.invitation.id } })).acceptedAt);
      assert.equal(identity.users.size, 1);
    });

    await t.test("simultaneous registrations for one email create one immutable identity and one membership", async () => {
      for (const mode of ["same-invitation", "different-invitations"] as const) {
        const first = await fixture(mode);
        const second = mode === "same-invitation" ? first : await fixture(`${mode}-second`, first.email);
        const identity = fakeAuth(createdUids);
        // Both preflights observe no identity before either attempts creation.
        let lookups = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        identity.auth.getUserByEmail = async () => {
          if (++lookups === 2) release();
          await gate;
          throw authError("auth/user-not-found");
        };
        const app = appFor(identity.auth);
        const responses = await Promise.all([register(app, first.token), register(app, second.token)]);
        assert.deepEqual(responses.map((result) => result.statusCode).sort(), [201, 409]);
        assert.equal(identity.users.size, 1);
        assert.equal(identity.requests.length, 2);
        const user = await prisma.appUser.findUniqueOrThrow({ where: { email: first.email } });
        assert.equal(user.firebaseUid, [...identity.users.keys()][0]);
        assert.equal(await prisma.tenantMembership.count({ where: { tenantId: { in: [first.tenant.id, second.tenant.id] }, userId: user.id } }), 1);
        assert.equal(await prisma.auditLog.count({ where: { tenantId: { in: [first.tenant.id, second.tenant.id] }, action: "access.invitation.register" } }), 1);
        assert.equal(await prisma.tenantInvitation.count({ where: { id: { in: [first.invitation.id, second.invitation.id] }, acceptedAt: { not: null } } }), 1);
      }
    });

    await t.test("per-invitation limits survive a new app instance, reset by window, and never persist unknown tokens", async () => {
      const f = await fixture("durable-limit");
      const identity = fakeAuth(createdUids);
      identity.seed(f.email);
      let now = Date.now();
      let app = appFor(identity.auth, { now: () => now });
      const beforeUnknown = await prisma.invitationRequestLimit.count();
      const unknown = await preview(app, "z".repeat(43));
      assert.equal(unknown.statusCode, 410);
      assert.equal(await prisma.invitationRequestLimit.count(), beforeUnknown);
      for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt === 5) app = appFor(identity.auth, { now: () => now });
        const result = await register(app, f.token);
        assert.equal(result.statusCode, 409, result.body);
      }
      const registerLimited = await register(app, f.token);
      assert.equal(registerLimited.statusCode, 429, registerLimited.body);
      assert.equal(registerLimited.headers["retry-after"], "600");
      for (let attempt = 0; attempt < 60; attempt++) {
        const result = await preview(app, f.token);
        assert.equal(result.statusCode, 200, result.body);
      }
      const previewLimited = await preview(app, f.token);
      assert.equal(previewLimited.statusCode, 429, previewLimited.body);
      const rows = await prisma.invitationRequestLimit.findMany({ where: { invitationId: f.invitation.id }, orderBy: { action: "asc" } });
      assert.deepEqual(rows.map(({ action, attempts }) => ({ action, attempts })), [{ action: "preview", attempts: 60 }, { action: "register", attempts: 10 }]);
      now += 10 * 60_000;
      assert.equal((await register(app, f.token)).statusCode, 409);
      assert.equal((await preview(app, f.token)).statusCode, 200);
      const resetRows = await prisma.invitationRequestLimit.findMany({ where: { invitationId: f.invitation.id } });
      assert.equal(resetRows.length, 2);
      assert(resetRows.every((row) => row.attempts === 1 && row.windowStartsAt.getTime() > rows[0].windowStartsAt.getTime()));
      assert.equal(identity.requests.length, 0);
      await noRegistration(f);
    });
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.appUser.deleteMany({ where: { OR: [{ id: { in: userIds } }, { firebaseUid: { in: [...createdUids] } }] } });
    await prisma.$disconnect();
    if (previousKey === undefined) delete process.env.INVITATION_TOKEN_KEY;
    else process.env.INVITATION_TOKEN_KEY = previousKey;
  }
});
