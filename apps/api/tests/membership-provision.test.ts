import assert from "node:assert/strict";
import test from "node:test";
import { buildMembershipProvisionPlan, MembershipProvisionError, membershipProgramSlug, parseMembershipProvisionCommand,
  parseMembershipProvisionRequest, type MembershipProvisionRequest, type MembershipProvisionSnapshot } from "../src/membership-provision.js";

const programId = "00000000-0000-4000-8000-000000000001";
const otherProgramId = "00000000-0000-4000-8000-000000000002";
const databaseFingerprint = "1".repeat(64);
const input: MembershipProvisionRequest = { programId, programName: "テナント専用会員", tenantSlug: "aaa-x", ownerUid: "private-operator-uid" };
function snapshot(): MembershipProvisionSnapshot {
  return { actor: { id: "private-operator-id", firebaseUid: input.ownerUid, disabled: false, updatedAt: "2026-10-30T00:00:00.000Z" },
    program: null, generatedSlugOwnerId: null, tenants: [{ id: "tenant-0", slug: input.tenantSlug,
      status: "ACTIVE", membershipProgramId: null, updatedAt: "2026-10-30T00:00:00.000Z",
      ownerMembership: { role: "OWNER", status: "ACTIVE", updatedAt: "2026-10-30T00:00:00.000Z" } }] };
}
function isCode(code: string) { return (error: unknown) => error instanceof MembershipProvisionError && error.code === code; }
const args = ["--program-id", programId, "--program-name", input.programName, "--tenant-slug", input.tenantSlug];
const env = { MEMBERSHIP_PROVISION_OWNER_UID: input.ownerUid };

test("membership provision defaults to dry-run with exactly one explicit tenant slug", () => {
  const command = parseMembershipProvisionCommand(args, env);
  assert.equal(command.apply, false); assert.equal(command.confirmationHash, undefined);
  assert.deepEqual(command.input, input);
  assert.equal(parseMembershipProvisionCommand([...args, "--dry-run"], env).apply, false);
  const confirmed = parseMembershipProvisionCommand([...args, "--apply", "--confirm-hash", "a".repeat(64)], env);
  assert.equal(confirmed.apply, true); assert.equal(confirmed.confirmationHash, "a".repeat(64));
});

test("apply cannot be selected accidentally or without a reviewed hash", () => {
  for (const extra of [["--apply"], ["--confirm-hash", "a".repeat(64)], ["--apply", "--confirm-hash", "bad"],
    ["--apply", "--dry-run", "--confirm-hash", "a".repeat(64)], ["--unknown"], ["unexpected"], ["--tenant-slug", "other"],
    ["--tenant-slugs", "aaa-x,aaaa"], ["--owner-uid", "forged"]]) {
    assert.throws(() => parseMembershipProvisionCommand([...args, ...extra], env), isCode("INVALID_PROVISION_INPUT"));
  }
  assert.throws(() => parseMembershipProvisionCommand(args, {}), isCode("INVALID_PROVISION_INPUT"));
});

test("tenant selection rejects multiple tenants, wildcards, omissions, route names and unknown request fields", () => {
  for (const tenantSlug of ["", "*", "aaa-x,aaaa", "aaa-x,aaa-x", "aaa*", "login", "AAA-X", "aaa x", ["aaa-x"]]) {
    assert.throws(() => parseMembershipProvisionRequest({ ...input, tenantSlug }), isCode("INVALID_PROVISION_INPUT"));
  }
  for (const change of [{ programId: "auto" }, { programName: "" }, { programName: "name\nsecret" }, { ownerUid: "" },
    { ownerUid: " uid " }, { customerId: "forged" }, { points: 100 }, { tenantSlugs: ["aaa-x", "aaaa"] }]) {
    assert.throws(() => parseMembershipProvisionRequest({ ...input, ...change }), isCode("INVALID_PROVISION_INPUT"));
  }
});

test("plan/hash are deterministic and contain no operator or customer identity", () => {
  const first = buildMembershipProvisionPlan(input, snapshot(), databaseFingerprint);
  const second = buildMembershipProvisionPlan({ ...input }, snapshot(), databaseFingerprint);
  assert.deepEqual(first, second); assert.match(first.confirmationHash, /^[a-f0-9]{64}$/);
  assert.equal(first.plan.program.slug, membershipProgramSlug(programId));
  assert.equal(first.plan.version, 2);
  assert.deepEqual(first.plan.changes, { programsCreated: 1, tenantsAssigned: 1 });
  for (const privateValue of [input.ownerUid, "private-operator-id", "firebaseUid", "ownerMembership", "updatedAt", "displayName", "password"]) {
    assert(!JSON.stringify(first).includes(privateValue));
  }
});

test("confirmation is bound to the database, actor, privileges and selected tenant", () => {
  const original = buildMembershipProvisionPlan(input, snapshot(), databaseFingerprint).confirmationHash;
  const changedActor = snapshot(); changedActor.actor!.firebaseUid = "different-operator";
  assert.notEqual(buildMembershipProvisionPlan({ ...input, ownerUid: "different-operator" }, changedActor, databaseFingerprint).confirmationHash, original);
  const changedRevision = snapshot(); changedRevision.tenants[0].ownerMembership!.updatedAt = "2026-10-30T01:00:00.000Z";
  assert.notEqual(buildMembershipProvisionPlan(input, changedRevision, databaseFingerprint).confirmationHash, original);
  assert.notEqual(buildMembershipProvisionPlan(input, snapshot(), "2".repeat(64)).confirmationHash, original);
  const differentTenant = snapshot(); differentTenant.tenants[0].slug = "other-tenant";
  assert.notEqual(buildMembershipProvisionPlan({ ...input, tenantSlug: "other-tenant" }, differentTenant, databaseFingerprint).confirmationHash, original);
});

test("the selected tenant must exist, be active and belong to the active operator as OWNER", () => {
  const missing = snapshot(); missing.tenants.pop();
  assert.throws(() => buildMembershipProvisionPlan(input, missing, databaseFingerprint), isCode("PROVISION_TENANT_NOT_FOUND"));
  for (const change of ["SUSPENDED", "CANCELLED"]) {
    const inactive = snapshot(); inactive.tenants[0].status = change;
    assert.throws(() => buildMembershipProvisionPlan(input, inactive, databaseFingerprint), isCode("PROVISION_TENANT_INACTIVE"));
  }
  for (const role of ["ADMIN", "MANAGER", "STAFF", "VIEWER"]) {
    const insufficient = snapshot(); insufficient.tenants[0].ownerMembership!.role = role;
    assert.throws(() => buildMembershipProvisionPlan(input, insufficient, databaseFingerprint), isCode("PROVISION_OWNER_REQUIRED"));
  }
  for (const mutate of [(value: MembershipProvisionSnapshot) => { value.actor = null; },
    (value: MembershipProvisionSnapshot) => { value.actor!.disabled = true; },
    (value: MembershipProvisionSnapshot) => { value.actor!.firebaseUid = "someone-else"; },
    (value: MembershipProvisionSnapshot) => { value.tenants[0].ownerMembership = null; },
    (value: MembershipProvisionSnapshot) => { value.tenants[0].ownerMembership!.status = "SUSPENDED"; }]) {
    const insufficient = snapshot(); mutate(insufficient);
    assert.throws(() => buildMembershipProvisionPlan(input, insufficient, databaseFingerprint), isCode("PROVISION_OWNER_REQUIRED"));
  }
});

test("existing programs are kept without renaming, reactivating, or replacing a tenant program", () => {
  const kept = snapshot(); kept.program = { id: programId, slug: "existing-business-program", name: input.programName, active: true, tenantId: "tenant-0" };
  kept.tenants[0].membershipProgramId = programId;
  const result = buildMembershipProvisionPlan(input, kept, databaseFingerprint);
  assert.equal(result.plan.program.action, "KEEP"); assert.equal(result.plan.program.slug, "existing-business-program");
  assert.equal(result.plan.tenant.action, "KEEP"); assert.deepEqual(result.plan.changes, { programsCreated: 0, tenantsAssigned: 0 });
  for (const change of [{ name: "different name" }, { active: false }]) {
    assert.throws(() => buildMembershipProvisionPlan(input, { ...kept, program: { ...kept.program!, ...change } }, databaseFingerprint), isCode("PROVISION_PROGRAM_CONFLICT"));
  }
  const reassigned = snapshot(); reassigned.tenants[0].membershipProgramId = otherProgramId;
  assert.throws(() => buildMembershipProvisionPlan(input, reassigned, databaseFingerprint), isCode("PROVISION_REASSIGNMENT_FORBIDDEN"));
  const collision = snapshot(); collision.generatedSlugOwnerId = otherProgramId;
  assert.throws(() => buildMembershipProvisionPlan(input, collision, databaseFingerprint), isCode("PROVISION_PROGRAM_CONFLICT"));
  const otherTenantProgram = snapshot(); otherTenantProgram.program = { ...kept.program!, tenantId: "another-tenant" };
  assert.throws(() => buildMembershipProvisionPlan(input, otherTenantProgram, databaseFingerprint), isCode("PROVISION_PROGRAM_ALREADY_ASSIGNED"));
});
