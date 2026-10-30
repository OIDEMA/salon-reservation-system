import { createHash, timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { isTenantSlug } from "./tenant-slug.js";

export class MembershipProvisionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
function requireProvision(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new MembershipProvisionError(code, message);
}
const noControlCharacters = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const requestSchema = z.object({
  programId: z.string().uuid().transform((value) => value.toLowerCase()),
  programName: z.string().trim().min(1).max(100).refine(noControlCharacters),
  tenantSlug: z.string().refine(isTenantSlug),
  ownerUid: z.string().min(1).max(128).refine((value) => value === value.trim() && noControlCharacters(value)),
}).strict();
export type MembershipProvisionRequest = z.infer<typeof requestSchema>;
export type MembershipProvisionCommand = {
  input: MembershipProvisionRequest; apply: boolean; confirmationHash?: string;
};
export function parseMembershipProvisionRequest(value: unknown): MembershipProvisionRequest {
  try {
    return requestSchema.parse(value);
  } catch {
    throw new MembershipProvisionError("INVALID_PROVISION_INPUT", "program UUID・name・完全指定のtenant slug 1件・実行者UIDを確認してください。");
  }
}
export function parseMembershipProvisionCommand(args: string[], env: NodeJS.ProcessEnv): MembershipProvisionCommand {
  try {
    const { values } = parseArgs({ args, allowPositionals: false, strict: true, options: {
      "program-id": { type: "string" }, "program-name": { type: "string" }, "tenant-slug": { type: "string" },
      "dry-run": { type: "boolean" }, apply: { type: "boolean" }, "confirm-hash": { type: "string" },
    } });
    // Repeated singleton flags can otherwise silently select their last value.
    const flags = args.filter((arg) => arg.startsWith("--")).map((arg) => arg.split("=", 1)[0]);
    requireProvision(new Set(flags).size === flags.length, "INVALID_PROVISION_INPUT", "同じオプションを重複指定しないでください。");
    requireProvision(!(values.apply && values["dry-run"]), "INVALID_PROVISION_INPUT", "applyとdry-runは同時指定できません。");
    const apply = values.apply === true;
    const confirmationHash = values["confirm-hash"];
    requireProvision(apply ? typeof confirmationHash === "string" && /^[a-f0-9]{64}$/.test(confirmationHash) : confirmationHash === undefined,
      "INVALID_PROVISION_INPUT", "applyには直前のdry-runの確認ハッシュを指定してください。");
    const input = parseMembershipProvisionRequest({
      programId: values["program-id"], programName: values["program-name"],
      tenantSlug: values["tenant-slug"], ownerUid: env.MEMBERSHIP_PROVISION_OWNER_UID,
    });
    return { input, apply, ...(confirmationHash ? { confirmationHash } : {}) };
  } catch (error) {
    if (error instanceof MembershipProvisionError) throw error;
    throw new MembershipProvisionError("INVALID_PROVISION_INPUT", "管理CLIのオプションを確認してください。未知のオプションや位置引数は受け付けません。");
  }
}

type ProgramSnapshot = { id: string; slug: string; name: string; active: boolean; tenantId: string | null };
export type MembershipProvisionSnapshot = {
  actor: { id: string; firebaseUid: string; disabled: boolean; updatedAt: string } | null;
  program: ProgramSnapshot | null;
  generatedSlugOwnerId: string | null;
  tenants: Array<{ id: string; slug: string; status: string; membershipProgramId: string | null; updatedAt: string;
    ownerMembership: { role: string; status: string; updatedAt: string } | null }>;
};
export type MembershipProvisionPlan = {
  version: 2; databaseFingerprint: string;
  program: { id: string; slug: string; name: string; action: "CREATE" | "KEEP" };
  tenant: { id: string; slug: string; action: "ASSIGN" | "KEEP" };
  changes: { programsCreated: number; tenantsAssigned: number };
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const membershipProgramSlug = (programId: string) => `membership-${programId}`;

/** The printable plan contains configuration only; actor identity is bound into the hash privately. */
export function buildMembershipProvisionPlan(value: MembershipProvisionRequest, snapshot: MembershipProvisionSnapshot, databaseFingerprint: string) {
  const input = parseMembershipProvisionRequest(value);
  requireProvision(/^[a-f0-9]{64}$/.test(databaseFingerprint), "INVALID_PROVISION_TARGET", "対象DBを確認できません。");
  const actor = snapshot.actor;
  requireProvision(actor && !actor.disabled && actor.firebaseUid === input.ownerUid, "PROVISION_OWNER_REQUIRED", "対象テナントの有効なOWNER権限が必要です。");
  requireProvision(snapshot.tenants.length === 1 && snapshot.tenants[0].slug === input.tenantSlug,
    "PROVISION_TENANT_NOT_FOUND", "完全指定された既存テナント1件を確認できません。");
  const tenant = snapshot.tenants[0];
  requireProvision(tenant.status === "ACTIVE", "PROVISION_TENANT_INACTIVE", "有効な既存テナントだけを指定してください。");
  requireProvision(tenant.ownerMembership?.role === "OWNER" && tenant.ownerMembership.status === "ACTIVE",
    "PROVISION_OWNER_REQUIRED", "対象テナントの有効なOWNER権限が必要です。");
  requireProvision(tenant.membershipProgramId === null || tenant.membershipProgramId === input.programId,
    "PROVISION_REASSIGNMENT_FORBIDDEN", "既存の会員プログラムからの付け替えはできません。");
  const existing = snapshot.program;
  requireProvision(!existing || existing.tenantId === null || existing.tenantId === tenant.id,
    "PROVISION_PROGRAM_ALREADY_ASSIGNED", "他テナントが使用中の会員プログラムは指定できません。テナントごとに別のUUIDを指定してください。");
  requireProvision(!existing || (existing.id === input.programId && existing.active && existing.name === input.programName),
    "PROVISION_PROGRAM_CONFLICT", "既存プログラムのID・名称・有効状態が指定内容と一致しません。名称変更や再有効化は行いません。");
  requireProvision(existing || snapshot.generatedSlugOwnerId === null || snapshot.generatedSlugOwnerId === input.programId,
    "PROVISION_PROGRAM_CONFLICT", "プログラム識別子が既存設定と競合しています。");
  const plan: MembershipProvisionPlan = {
    version: 2, databaseFingerprint,
    program: { id: input.programId, slug: existing?.slug ?? membershipProgramSlug(input.programId), name: input.programName, action: existing ? "KEEP" : "CREATE" },
    tenant: { id: tenant.id, slug: tenant.slug, action: tenant.membershipProgramId === input.programId ? "KEEP" : "ASSIGN" },
    changes: { programsCreated: existing ? 0 : 1, tenantsAssigned: tenant.membershipProgramId === null ? 1 : 0 },
  };
  // Bind the operator, privileges, and reviewed state without printing any of them.
  const confirmationHash = sha256(JSON.stringify({ plan, actor, program: existing, tenant }));
  return { plan, confirmationHash };
}
function confirmProvision(expected: unknown, actual: string) {
  requireProvision(typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex")),
  "PROVISION_PLAN_CHANGED", "dry-runの確認ハッシュが一致しません。最新状態でdry-runをやり直してください。");
}

type Tx = Prisma.TransactionClient;
async function lockProvisionRows(tx: Tx, input: MembershipProvisionRequest) {
  await tx.$queryRaw`SELECT id FROM "AppUser" WHERE "firebaseUid"=${input.ownerUid} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE slug=${input.tenantSlug} FOR UPDATE`;
  await tx.$queryRaw`SELECT m."tenantId" FROM "TenantMembership" m JOIN "AppUser" u ON u.id=m."userId"
    JOIN "Tenant" t ON t.id=m."tenantId" WHERE u."firebaseUid"=${input.ownerUid} AND t.slug=${input.tenantSlug}
    ORDER BY m."tenantId" FOR SHARE OF m`;
  await tx.$queryRaw`SELECT id FROM "MembershipProgram" WHERE id=${input.programId} OR slug=${membershipProgramSlug(input.programId)} ORDER BY id FOR SHARE`;
}
async function readProvisionSnapshot(tx: Tx, input: MembershipProvisionRequest): Promise<MembershipProvisionSnapshot> {
  const actor = await tx.appUser.findUnique({ where: { firebaseUid: input.ownerUid }, select: { id: true, firebaseUid: true, disabled: true, updatedAt: true } });
  const [program, slugOwner, tenants] = await Promise.all([
    tx.membershipProgram.findUnique({ where: { id: input.programId }, select: { id: true, slug: true, name: true, active: true, tenant: { select: { id: true } } } }),
    tx.membershipProgram.findUnique({ where: { slug: membershipProgramSlug(input.programId) }, select: { id: true } }),
    tx.tenant.findMany({ where: { slug: input.tenantSlug }, select: {
      id: true, slug: true, status: true, membershipProgramId: true, updatedAt: true,
      memberships: { where: { userId: actor?.id ?? "" }, select: { role: true, status: true, updatedAt: true }, take: 1 },
    } }),
  ]);
  return { actor: actor ? { ...actor, updatedAt: actor.updatedAt.toISOString() } : null,
    program: program ? { id: program.id, slug: program.slug, name: program.name, active: program.active, tenantId: program.tenant?.id ?? null } : null,
    generatedSlugOwnerId: slugOwner?.id ?? null,
    tenants: tenants.map(({ memberships, ...tenant }) => ({ ...tenant, updatedAt: tenant.updatedAt.toISOString(), ownerMembership: memberships[0] ? {
      ...memberships[0], updatedAt: memberships[0].updatedAt.toISOString(),
    } : null })) };
}
async function fingerprintDatabase(tx: Tx) {
  const rows = await tx.$queryRaw<Array<{ database: string; schema: string; address: string | null; port: number | null }>>`
    SELECT current_database()::text AS database, current_schema()::text AS schema, inet_server_addr()::text AS address, inet_server_port() AS port`;
  requireProvision(rows.length === 1 && rows[0].database && rows[0].schema, "INVALID_PROVISION_TARGET", "対象DBを確認できません。");
  return sha256(JSON.stringify(rows[0]));
}

/** No Firebase calls, schema changes, client records, links, or ledger writes occur here. */
export async function provisionMembership(database: Pick<PrismaClient, "$transaction">, value: MembershipProvisionRequest,
  options: { apply?: boolean; confirmationHash?: string } = {}) {
  const input = parseMembershipProvisionRequest(value);
  const apply = options.apply === true;
  if (apply) requireProvision(typeof options.confirmationHash === "string" && /^[a-f0-9]{64}$/.test(options.confirmationHash),
    "PROVISION_PLAN_CHANGED", "applyにはdry-runの確認ハッシュが必要です。");
  try {
    return await database.$transaction(async (tx) => {
      if (apply) await lockProvisionRows(tx, input);
      const snapshot = await readProvisionSnapshot(tx, input);
      const prepared = buildMembershipProvisionPlan(input, snapshot, await fingerprintDatabase(tx));
      if (!apply) return { mode: "DRY_RUN" as const, ...prepared };
      confirmProvision(options.confirmationHash, prepared.confirmationHash);
      const { plan, confirmationHash } = prepared;
      const actorUserId = snapshot.actor!.id;
      const metadata = { source: "operator-cli", planHash: confirmationHash };
      if (plan.program.action === "CREATE") {
        await tx.membershipProgram.create({ data: { id: plan.program.id, slug: plan.program.slug, name: plan.program.name, active: true } });
        await tx.auditLog.create({ data: { tenantId: plan.tenant.id, actorUserId, action: "membership.program.create",
          resource: "membershipProgram", resourceId: plan.program.id, metadata: { ...metadata, participatingTenantCount: 1 } } });
      }
      const tenant = plan.tenant;
      if (tenant.action === "ASSIGN") {
        const updated = await tx.tenant.updateMany({ where: { id: tenant.id, slug: tenant.slug, status: "ACTIVE", membershipProgramId: null },
          data: { membershipProgramId: plan.program.id } });
        requireProvision(updated.count === 1, "PROVISION_PLAN_CHANGED", "テナント設定が変更されました。dry-runをやり直してください。");
        await tx.auditLog.create({ data: { tenantId: tenant.id, actorUserId, action: "membership.program.assign", resource: "membershipProgram",
          resourceId: plan.program.id, metadata: { ...metadata, previousProgramId: null } } });
      }
      return { mode: "APPLIED" as const, ...prepared };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 20_000 });
  } catch (error) {
    if (error instanceof MembershipProvisionError) throw error;
    const conflict = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002" ||
      error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)));
    if (conflict) throw new MembershipProvisionError("PROVISION_CONFLICT", "同時更新と競合しました。全変更を中止しました。dry-runをやり直してください。");
    throw new MembershipProvisionError("PROVISION_FAILED", "管理操作を完了できませんでした。DB接続・権限を確認し、最新のdry-runで適用状況を確認してください。");
  }
}
