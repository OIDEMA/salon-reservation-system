import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { UserRecord } from "firebase-admin/auth";
import { createInvitedIdentity, invitationPreviewSchema, invitationRegistrationSchema, invitationRequestLimiter,
  registerInvitationRegistrationRoutes, type RegistrationAuth } from "../src/invitation-registration.js";

const token = "T".repeat(43);
const input = { token, displayName: " 新しい担当者 ", password: " password with spaces " };
const record = (uid: string, email = "invite@example.test") => ({ uid, email, emailVerified: true, disabled: false }) as UserRecord;
function authWith(createUser: RegistrationAuth["createUser"], getUser?: RegistrationAuth["getUser"]): RegistrationAuth {
  return { createUser, getUser: getUser ?? (async () => { throw new Error("unexpected lookup"); }),
    getUserByEmail: async () => { throw new Error("unexpected email lookup"); } };
}

test("registration only accepts token/name/password, preserving the exact password", () => {
  const parsed = invitationRegistrationSchema.parse(input);
  assert.equal(parsed.displayName, "新しい担当者");
  assert.equal(parsed.password, input.password);
  for (const extra of [{ email: "attacker@example.test" }, { uid: "privileged" }, { role: "OWNER" }, { salonIds: [] }]) {
    assert(!invitationRegistrationSchema.safeParse({ ...input, ...extra }).success);
  }
  for (const displayName of ["", " ", "x\nname", "x\u0000name", "a".repeat(101)]) {
    assert(!invitationRegistrationSchema.safeParse({ ...input, displayName }).success);
  }
  for (const password of ["short", "x".repeat(129)]) assert(!invitationRegistrationSchema.safeParse({ ...input, password }).success);
  for (const invalidToken of ["", "T".repeat(42), "T".repeat(44), "!".repeat(43)]) assert(!invitationPreviewSchema.safeParse({ token: invalidToken }).success);
  assert(!invitationPreviewSchema.safeParse({ token, password: "extra" }).success);
});

test("early request limiter expires windows and bounds storage for arbitrary IPs", () => {
  let clock = 1000;
  const guard = invitationRequestLimiter(() => clock, 2, 2);
  guard("ip1"); guard("ip1");
  assert.throws(() => guard("ip1"), { code: "INVITATION_RATE_LIMIT", statusCode: 429 });
  guard("ip2");
  assert.throws(() => guard("ip3"), { code: "INVITATION_RATE_LIMIT" });
  clock += 60_000;
  guard("ip3"); guard("ip1");
});

test("new Firebase identity is bound to the server-selected UID/email and verified mailbox", async () => {
  let captured: unknown;
  await createInvitedIdentity(authWith(async (properties) => { captured = properties; return record(properties.uid!); }),
    "invite@example.test", "担当者", input.password, "invite-owned-uid");
  assert.deepEqual(captured, { uid: "invite-owned-uid", email: "invite@example.test", displayName: "担当者", password: input.password, emailVerified: true, disabled: false });
});

test("existing Firebase account is never updated, deleted or adopted", async () => {
  let lookups = 0;
  const auth = authWith(async () => { throw { code: "auth/email-already-exists", secret: input.password }; }, async () => { lookups++; return record("existing"); });
  await assert.rejects(createInvitedIdentity(auth, "invite@example.test", "担当者", input.password, "invite-new"), { code: "INVITATION_ACCOUNT_EXISTS", statusCode: 409 });
  assert.equal(lookups, 0);
});

test("ambiguous Firebase create resolves only through this request's exact UID", async () => {
  let lookedUp: string | undefined;
  await createInvitedIdentity(authWith(async () => { throw new Error("timeout"); }, async (uid) => { lookedUp = uid; return record(uid); }),
    "invite@example.test", "担当者", input.password, "invite-owned-uid");
  assert.equal(lookedUp, "invite-owned-uid");
  for (const found of [record("different"), record("invite-owned-uid", "other@example.test"), { ...record("invite-owned-uid"), emailVerified: false }, { ...record("invite-owned-uid"), disabled: true }]) {
    await assert.rejects(createInvitedIdentity(authWith(async () => { throw new Error("timeout"); }, async () => found as UserRecord),
      "invite@example.test", "担当者", input.password, "invite-owned-uid"), { code: "INVITATION_REGISTRATION_UNAVAILABLE", statusCode: 503 });
  }
});

test("public endpoints validate early, never echo credentials, and prohibit caching", async () => {
  let reads = 0;
  const logs: string[] = [];
  const db = { tenantInvitation: { findUnique: async () => { reads++; throw new Error(`${input.password}:${token}`); } } } as unknown as PrismaClient;
  const app = Fastify({ logger: { level: "warn", stream: new Writable({ write(chunk, _encoding, callback) { logs.push(String(chunk)); callback(); } }) } });
  registerInvitationRegistrationRoutes(app, { database: db });
  try {
    for (const action of ["preview", "register"]) {
      const bad = await app.inject({ method: "POST", url: `/api/access/invitations/${action}`, payload: { token: "bad", password: input.password } });
      assert.equal(bad.statusCode, 400);
      assert.equal(bad.json().code, "INVALID_INPUT");
      assert(!bad.body.includes(input.password));
      assert.equal(bad.headers["cache-control"], "no-store");
    }
    assert.equal(reads, 0);
    const response = await app.inject({ method: "POST", url: "/api/access/invitations/register", payload: input });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "INVITATION_REGISTRATION_UNAVAILABLE");
    assert(!response.body.includes(input.password)); assert(!response.body.includes(token));
    assert.equal(response.headers.pragma, "no-cache");
    assert(logs.join("").includes("INVITATION_REGISTRATION_UNAVAILABLE"));
    assert(!logs.join("").includes(input.password)); assert(!logs.join("").includes(token));
  } finally { await app.close(); }
});
