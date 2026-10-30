import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { MembershipProvisionError, provisionMembership, type MembershipProvisionRequest } from "../src/membership-provision.js";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("membership provisioning isolates one tenant and commits only its approved atomic plan", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use an explicit disposable local *_test database");
  const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
  const prefix = `membership-provision-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [], userIds: string[] = [], programIds: string[] = [];
  let serial = 0;
  function isCode(code: string) { return (error: unknown) => error instanceof MembershipProvisionError && error.code === code; }
  async function fixture(count = 1) {
    const suffix = serial++;
    const owner = await database.appUser.create({ data: { firebaseUid: `${prefix}-owner-${suffix}`, email: `${prefix}-${suffix}@example.test`, displayName: "private operator name" } });
    userIds.push(owner.id);
    const tenants = [];
    for (let index = 0; index < count; index++) {
      const tenant = await database.tenant.create({ data: { slug: `${prefix}-${suffix}-${index}`, name: "private company label" } });
      tenantIds.push(tenant.id); tenants.push(tenant);
      await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });
    }
    const programId = randomUUID(); programIds.push(programId);
    const input: MembershipProvisionRequest = { programId, programName: "隔離DB確認用プログラム", tenantSlug: tenants[0].slug, ownerUid: owner.firebaseUid };
    return { owner, tenants, input };
  }
  async function scopedClientCounts(tenants: string[], programId: string) {
    return Promise.all([
      database.tenant.count({ where: { id: { in: tenants } } }),
      database.customer.count({ where: { tenantId: { in: tenants } } }),
      database.membershipAccount.count({ where: { programId } }),
      database.memberCustomerLink.count({ where: { tenantId: { in: tenants } } }),
      database.membershipCustomerLink.count({ where: { tenantId: { in: tenants } } }),
      database.membershipPointEntry.count({ where: { programId } }),
      database.reservation.count({ where: { tenantId: { in: tenants } } }),
    ]);
  }
  try {
    await t.test("CLI entrypoint defaults to dry-run and requires its exact hash for apply", async () => {
      const f = await fixture();
      const execute = promisify(execFile);
      const args = ["--import", "tsx", fileURLToPath(new URL("../src/scripts/provision-membership.ts", import.meta.url)),
        "--program-id", f.input.programId, "--program-name", f.input.programName, "--tenant-slug", f.input.tenantSlug];
      const options = { env: { ...process.env, DATABASE_URL: testDatabaseUrl!, MEMBERSHIP_PROVISION_OWNER_UID: f.owner.firebaseUid }, timeout: 10_000 };
      const dryRun = await execute(process.execPath, args, options);
      const reviewed = JSON.parse(dryRun.stdout); assert.equal(reviewed.mode, "DRY_RUN"); assert.equal(dryRun.stderr, "");
      assert.equal(await database.membershipProgram.count({ where: { id: f.input.programId } }), 0);
      await assert.rejects(execute(process.execPath, [...args, "--apply", "--confirm-hash", "0".repeat(64)], options), (error: any) => {
        assert.equal(error.stdout, ""); assert.equal(JSON.parse(error.stderr).code, "PROVISION_PLAN_CHANGED");
        assert(!error.stderr.includes(f.owner.firebaseUid)); assert(!error.stderr.includes(testDatabaseUrl!)); return true;
      });
      const applied = await execute(process.execPath, [...args, "--apply", "--confirm-hash", reviewed.confirmationHash], options);
      assert.equal(JSON.parse(applied.stdout).mode, "APPLIED"); assert.equal(applied.stderr, "");
      assert.equal(await database.membershipProgram.count({ where: { id: f.input.programId } }), 1);
      assert(!applied.stdout.includes(f.owner.firebaseUid)); assert(!applied.stdout.includes(testDatabaseUrl!));
    });

    await t.test("dry-run makes no writes; apply creates only the program, approved assignments and audit", async () => {
      const f = await fixture(); const ids = f.tenants.map((tenant) => tenant.id);
      const before = await scopedClientCounts(ids, f.input.programId);
      const reviewed = await provisionMembership(database, f.input);
      assert.equal(reviewed.mode, "DRY_RUN"); assert.equal(await database.membershipProgram.count({ where: { id: f.input.programId } }), 0);
      assert.equal(await database.auditLog.count({ where: { tenantId: { in: ids } } }), 0);
      assert((await database.tenant.findMany({ where: { id: { in: ids } } })).every((tenant) => tenant.membershipProgramId === null));
      const repeat = await provisionMembership(database, { ...f.input });
      assert.equal(repeat.confirmationHash, reviewed.confirmationHash);
      await assert.rejects(provisionMembership(database, f.input, { apply: true, confirmationHash: "0".repeat(64) }), isCode("PROVISION_PLAN_CHANGED"));
      assert.equal(await database.membershipProgram.count({ where: { id: f.input.programId } }), 0);
      const applied = await provisionMembership(database, f.input, { apply: true, confirmationHash: reviewed.confirmationHash });
      assert.equal(applied.mode, "APPLIED"); assert.deepEqual(applied.plan.changes, { programsCreated: 1, tenantsAssigned: 1 });
      assert((await database.tenant.findMany({ where: { id: { in: ids } } })).every((tenant) => tenant.membershipProgramId === f.input.programId));
      assert.deepEqual(await scopedClientCounts(ids, f.input.programId), before);
      const audit = await database.auditLog.findMany({ where: { tenantId: { in: ids } } });
      assert.equal(audit.length, 2); assert(audit.every((entry) => entry.actorUserId === f.owner.id));
      assert.equal(audit.filter((entry) => entry.action === "membership.program.assign").length, 1);
      const printed = JSON.stringify(applied);
      for (const privateValue of [f.owner.firebaseUid, f.owner.id, f.owner.email!, f.owner.displayName!, "private company label"]) assert(!printed.includes(privateValue));
      const after = await provisionMembership(database, f.input);
      assert.deepEqual(after.plan.changes, { programsCreated: 0, tenantsAssigned: 0 });
      await provisionMembership(database, f.input, { apply: true, confirmationHash: after.confirmationHash });
      assert.equal(await database.auditLog.count({ where: { tenantId: { in: ids } } }), 2);
    });

    await t.test("missing, inactive, unauthorized or disabled owners cannot create even the program", async () => {
      const f = await fixture();
      await assert.rejects(provisionMembership(database, { ...f.input, tenantSlug: `${prefix}-missing` }), isCode("PROVISION_TENANT_NOT_FOUND"));
      await database.tenant.update({ where: { id: f.tenants[0].id }, data: { status: "SUSPENDED" } });
      await assert.rejects(provisionMembership(database, f.input), isCode("PROVISION_TENANT_INACTIVE"));
      await database.tenant.update({ where: { id: f.tenants[0].id }, data: { status: "ACTIVE" } });
      await database.tenantMembership.update({ where: { tenantId_userId: { tenantId: f.tenants[0].id, userId: f.owner.id } }, data: { role: "ADMIN" } });
      await assert.rejects(provisionMembership(database, f.input), isCode("PROVISION_OWNER_REQUIRED"));
      await database.tenantMembership.update({ where: { tenantId_userId: { tenantId: f.tenants[0].id, userId: f.owner.id } }, data: { role: "OWNER", status: "SUSPENDED" } });
      await assert.rejects(provisionMembership(database, f.input), isCode("PROVISION_OWNER_REQUIRED"));
      await database.tenantMembership.update({ where: { tenantId_userId: { tenantId: f.tenants[0].id, userId: f.owner.id } }, data: { status: "ACTIVE" } });
      await database.appUser.update({ where: { id: f.owner.id }, data: { disabled: true } });
      await assert.rejects(provisionMembership(database, f.input), isCode("PROVISION_OWNER_REQUIRED"));
      await assert.rejects(provisionMembership(database, { ...f.input, ownerUid: `${prefix}-missing-uid` }), isCode("PROVISION_OWNER_REQUIRED"));
      assert.equal(await database.membershipProgram.count({ where: { id: f.input.programId } }), 0);
      assert.equal(await database.auditLog.count({ where: { tenantId: { in: f.tenants.map((tenant) => tenant.id) } } }), 0);
    });

    await t.test("apply rechecks owner and reviewed state rather than trusting an old plan", async () => {
      const f = await fixture(); const reviewed = await provisionMembership(database, f.input);
      await database.tenantMembership.update({ where: { tenantId_userId: { tenantId: f.tenants[0].id, userId: f.owner.id } }, data: { role: "STAFF" } });
      await assert.rejects(provisionMembership(database, f.input, { apply: true, confirmationHash: reviewed.confirmationHash }), isCode("PROVISION_OWNER_REQUIRED"));
      await database.tenantMembership.update({ where: { tenantId_userId: { tenantId: f.tenants[0].id, userId: f.owner.id } }, data: { role: "OWNER" } });
      const fresh = await provisionMembership(database, f.input);
      await database.tenant.update({ where: { id: f.tenants[0].id }, data: { name: "configuration changed after review" } });
      await assert.rejects(provisionMembership(database, f.input, { apply: true, confirmationHash: fresh.confirmationHash }), isCode("PROVISION_PLAN_CHANGED"));
      assert.equal(await database.membershipProgram.count({ where: { id: f.input.programId } }), 0);
    });

    await t.test("existing programs cannot be replaced, renamed or reactivated", async () => {
      const f = await fixture();
      const previous = await database.membershipProgram.create({ data: { slug: `${prefix}-previous`, name: "以前のプログラム" } }); programIds.push(previous.id);
      await database.tenant.update({ where: { id: f.tenants[0].id }, data: { membershipProgramId: previous.id } });
      await assert.rejects(provisionMembership(database, f.input), isCode("PROVISION_REASSIGNMENT_FORBIDDEN"));
      assert.equal(await database.membershipProgram.count({ where: { id: f.input.programId } }), 0);
      const priorInput = { ...f.input, programId: previous.id, programName: previous.name };
      const reviewed = await provisionMembership(database, priorInput);
      await provisionMembership(database, priorInput, { apply: true, confirmationHash: reviewed.confirmationHash });
      await assert.rejects(provisionMembership(database, { ...priorInput, programName: "勝手な名称変更" }), isCode("PROVISION_PROGRAM_CONFLICT"));
      await database.membershipProgram.update({ where: { id: previous.id }, data: { active: false } });
      await assert.rejects(provisionMembership(database, priorInput), isCode("PROVISION_PROGRAM_CONFLICT"));
      assert.equal((await database.membershipProgram.findUniqueOrThrow({ where: { id: previous.id } })).name, previous.name);
    });

    await t.test("another tenant's program is refused even when the operator owns both tenants", async () => {
      const f = await fixture(2);
      const previous = await database.membershipProgram.create({ data: { slug: `${prefix}-foreign-program`, name: "他テナント専用" } }); programIds.push(previous.id);
      await database.tenant.update({ where: { id: f.tenants[1].id }, data: { membershipProgramId: previous.id } });
      await assert.rejects(provisionMembership(database, { ...f.input, programId: previous.id, programName: previous.name }), isCode("PROVISION_PROGRAM_ALREADY_ASSIGNED"));
      assert.equal((await database.tenant.findUniqueOrThrow({ where: { id: f.tenants[0].id } })).membershipProgramId, null);
      assert.equal(await database.auditLog.count({ where: { tenantId: f.tenants[0].id } }), 0);
      await database.tenantMembership.update({ where: { tenantId_userId: { tenantId: f.tenants[1].id, userId: f.owner.id } }, data: { role: "STAFF" } });
      const reviewed = await provisionMembership(database, f.input);
      await provisionMembership(database, f.input, { apply: true, confirmationHash: reviewed.confirmationHash });
      assert.equal((await database.tenant.findUniqueOrThrow({ where: { id: f.tenants[1].id } })).membershipProgramId, previous.id);
    });

    await t.test("an audit failure rolls back program creation and all assignments", async () => {
      const f = await fixture(); const reviewed = await provisionMembership(database, f.input);
      const failAuditDatabase = { $transaction: (callback: any, options: any) => database.$transaction((tx) => {
        const auditLog = new Proxy(tx.auditLog, { get(delegate, property) {
          if (property === "create") return (args: any) => {
            if (args.data.action === "membership.program.assign") throw new Error("simulated audit failure after writes");
            return delegate.create(args);
          };
          return Reflect.get(delegate, property);
        } });
        return callback(new Proxy(tx, { get(delegate, property) { return property === "auditLog" ? auditLog : Reflect.get(delegate, property); } }));
      }, options) } as Pick<PrismaClient, "$transaction">;
      await assert.rejects(provisionMembership(failAuditDatabase, f.input, { apply: true, confirmationHash: reviewed.confirmationHash }), isCode("PROVISION_FAILED"));
      assert.equal(await database.membershipProgram.count({ where: { id: f.input.programId } }), 0);
      assert.equal(await database.auditLog.count({ where: { tenantId: { in: f.tenants.map((tenant) => tenant.id) } } }), 0);
      assert((await database.tenant.findMany({ where: { id: { in: f.tenants.map((tenant) => tenant.id) } } })).every((tenant) => tenant.membershipProgramId === null));
    });

    await t.test("concurrent programs targeting one tenant have exactly one winner and no partial loser", async () => {
      const f = await fixture(); const secondProgramId = randomUUID(); programIds.push(secondProgramId);
      const first = { ...f.input };
      const second = { ...f.input, programId: secondProgramId };
      const [firstPlan, secondPlan] = await Promise.all([provisionMembership(database, first), provisionMembership(database, second)]);
      const results = await Promise.allSettled([
        provisionMembership(database, first, { apply: true, confirmationHash: firstPlan.confirmationHash }),
        provisionMembership(database, second, { apply: true, confirmationHash: secondPlan.confirmationHash }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const winner = results[0].status === "fulfilled" ? first : second;
      const loser = results[0].status === "fulfilled" ? second : first;
      const tenants = await database.tenant.findMany({ where: { id: { in: f.tenants.map((tenant) => tenant.id) } } });
      assert.equal(tenants.length, 1); assert.equal(tenants[0].membershipProgramId, winner.programId);
      assert.equal(await database.membershipProgram.count({ where: { id: winner.programId } }), 1);
      assert.equal(await database.membershipProgram.count({ where: { id: loser.programId } }), 0);
      assert.equal(await database.auditLog.count({ where: { tenantId: f.tenants[0].id } }), 2);
      const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      assert(failed.reason instanceof MembershipProvisionError);
      assert(["PROVISION_CONFLICT", "PROVISION_REASSIGNMENT_FORBIDDEN", "PROVISION_PLAN_CHANGED"].includes(failed.reason.code));
    });

    await t.test("concurrent tenants cannot share even an explicitly identical new program UUID", async () => {
      const f = await fixture(2);
      const first = { ...f.input }, second = { ...f.input, tenantSlug: f.tenants[1].slug };
      const [firstPlan, secondPlan] = await Promise.all([provisionMembership(database, first), provisionMembership(database, second)]);
      const results = await Promise.allSettled([
        provisionMembership(database, first, { apply: true, confirmationHash: firstPlan.confirmationHash }),
        provisionMembership(database, second, { apply: true, confirmationHash: secondPlan.confirmationHash }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const winner = results[0].status === "fulfilled" ? first : second;
      const tenants = await database.tenant.findMany({ where: { id: { in: f.tenants.map((tenant) => tenant.id) } } });
      for (const tenant of tenants) assert.equal(tenant.membershipProgramId, tenant.slug === winner.tenantSlug ? f.input.programId : null);
      assert.equal(await database.membershipProgram.count({ where: { id: f.input.programId } }), 1);
      assert.equal(await database.auditLog.count({ where: { tenantId: { in: f.tenants.map((tenant) => tenant.id) } } }), 2);
    });
  } finally {
    // Only these fixtures are touched; no schema/trigger changes or ledger cleanup are required.
    await database.$transaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      await tx.appUser.deleteMany({ where: { id: { in: userIds } } });
      await tx.membershipProgram.deleteMany({ where: { id: { in: programIds } } });
    });
    await database.$disconnect();
  }
});
