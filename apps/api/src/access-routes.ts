import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient, TenantMembership } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { requireAuthenticatedUser, requestedSalonId, type TenantContext } from "./tenant-context.js";
import { AccessPolicyError, assertAccessAssignment, canManageMember, effectivePermissions, hasPermission, PERMISSIONS, requirePermission } from "./permissions.js";
import { InvitationEmailError, sendInvitationEmail } from "./invitation-email.js";

const assignmentSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "MANAGER", "STAFF", "VIEWER"]),
  useCustomPermissions: z.boolean().default(false),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]),
  salonIds: z.array(z.string().min(1).max(100)).max(100).default([])
}).strict();
const memberSchema = assignmentSchema.extend({ status: z.enum(["ACTIVE", "SUSPENDED"]) });
const inviteSchema = assignmentSchema.extend({ email: z.string().trim().email().max(254), expiresInDays: z.number().int().min(1).max(7).default(7) });
const idSchema = z.object({ id: z.string().min(1).max(100) });
const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
type Transaction = Prisma.TransactionClient;

export function hashInvitationToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function assertInvitationUsable(invitation: { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; email: string }, email: string | null, now = new Date()) {
  if (invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now) {
    throw new AccessPolicyError("INVITATION_UNAVAILABLE", "この招待は期限切れ、取消済み、または承諾済みです。", 410);
  }
  if (!email || invitation.email.toLowerCase() !== email.toLowerCase()) {
    throw new AccessPolicyError("INVITATION_EMAIL_MISMATCH", "招待先と同じ確認済みメールアドレスでログインしてください。");
  }
}

function publicInvitation(invitation: { id: string; email: string; role: string; useCustomPermissions: boolean; permissions: string[]; salonIds: string[]; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null; createdAt: Date }) {
  return {
    id: invitation.id, email: invitation.email, role: invitation.role, useCustomPermissions: invitation.useCustomPermissions,
    permissions: invitation.permissions, salonIds: invitation.salonIds,
    expiresAt: invitation.expiresAt, acceptedAt: invitation.acceptedAt, revokedAt: invitation.revokedAt, createdAt: invitation.createdAt
  };
}

function auditData(request: FastifyRequest, context: TenantContext, action: string, resource: string, resourceId: string) {
  return { tenantId: context.tenant.id, actorUserId: context.user.id, action, resource, resourceId, ipAddress: request.ip, userAgent: request.headers["user-agent"] };
}

async function lockTenant(transaction: Transaction, tenantId: string) {
  await transaction.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
}

async function currentActor(transaction: Transaction, context: TenantContext): Promise<TenantMembership> {
  await transaction.$queryRaw`SELECT id FROM "AppUser" WHERE id=${context.user.id} FOR UPDATE`;
  await transaction.$queryRaw`SELECT "userId" FROM "TenantMembership" WHERE "tenantId"=${context.tenant.id} AND "userId"=${context.user.id} FOR UPDATE`;
  const membership = await transaction.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: context.tenant.id, userId: context.user.id } }, include: { user: true, tenant: true } });
  if (!membership || membership.user.disabled || membership.tenant.status !== "ACTIVE" || !hasPermission(membership, "access.manage")) {
    throw new AccessPolicyError("ACCESS_MANAGEMENT_DENIED", "権限を管理できません。");
  }
  return membership;
}

type AccessDependencies = {
  database?: PrismaClient;
  authorize?: typeof requirePermission;
  authenticate?: typeof requireAuthenticatedUser;
  sendInvitation?: typeof sendInvitationEmail;
};

export function registerAccessRoutes(server: FastifyInstance, dependencies: AccessDependencies = {}) {
  const db = dependencies.database ?? prisma;
  const authorize = dependencies.authorize ?? requirePermission;
  const authenticate = dependencies.authenticate ?? requireAuthenticatedUser;
  const sendInvitation = dependencies.sendInvitation ?? sendInvitationEmail;

  server.get("/api/access/members", async (request, reply) => {
    const context = await authorize(request, reply, "access.manage");
    if (!context) return;
    const [members, salons, invitations] = await Promise.all([
      db.tenantMembership.findMany({ where: { tenantId: context.tenant.id }, include: { user: { select: { id: true, email: true, displayName: true, disabled: true } } }, orderBy: { createdAt: "asc" } }),
      db.salon.findMany({ where: { tenantId: context.tenant.id }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } }),
      db.tenantInvitation.findMany({ where: { tenantId: context.tenant.id }, orderBy: { createdAt: "desc" }, take: 100 })
    ]);
    return {
      actorUserId: context.user.id, actorRole: context.membership.role, actorPermissions: effectivePermissions(context.membership),
      actorSalonIds: context.membership.role === "OWNER" ? [] : context.membership.salonIds,
      members: members.filter((member) => canManageMember(context.membership, member)).map((member) => ({ userId: member.userId, role: member.role, status: member.status, useCustomPermissions: member.useCustomPermissions,
        permissions: member.permissions, effectivePermissions: effectivePermissions(member), salonIds: member.role === "OWNER" ? [] : member.salonIds,
        createdAt: member.createdAt, user: member.user })),
      salons: salons.filter((salon) => context.membership.role === "OWNER" || !context.membership.salonIds.length || context.membership.salonIds.includes(salon.id)),
      invitations: invitations.filter((invitation)=>canManageMember(context.membership,invitation)).map(publicInvitation)
    };
  });

  server.patch("/api/access/members/:id", async (request, reply) => {
    const context = await authorize(request, reply, "access.manage");
    if (!context) return;
    const { id } = idSchema.parse(request.params);
    const input = memberSchema.parse(request.body);
    const result = await db.$transaction(async (transaction) => {
      await lockTenant(transaction, context.tenant.id);
      const actor = await currentActor(transaction, context);
      const target = await transaction.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: context.tenant.id, userId: id } } });
      if (!target) throw new AccessPolicyError("MEMBER_NOT_FOUND", "メンバーが見つかりません。", 404);
      const salons = await transaction.salon.findMany({ where: { tenantId: context.tenant.id }, select: { id: true } });
      assertAccessAssignment(actor, id, target, input, salons.map((salon) => salon.id));
      if (target.role === "OWNER" && target.status === "ACTIVE" && (input.role !== "OWNER" || input.status !== "ACTIVE")) {
        const owners = await transaction.tenantMembership.count({ where: { tenantId: context.tenant.id, role: "OWNER", status: "ACTIVE", user: { disabled: false } } });
        if (owners <= 1) throw new AccessPolicyError("LAST_OWNER_REQUIRED", "最後の有効なオーナーは変更・停止できません。");
      }
      const updated = await transaction.tenantMembership.update({ where: { tenantId_userId: { tenantId: context.tenant.id, userId: id } },
        data: { ...input, salonIds: input.role === "OWNER" ? [] : [...new Set(input.salonIds)], permissions: [...new Set(input.permissions)] } });
      await transaction.auditLog.create({ data: auditData(request, context, "access.member.update", "tenantMembership", id) });
      return updated;
    });
    return { userId: result.userId, role: result.role, status: result.status, useCustomPermissions: result.useCustomPermissions,
      permissions: result.permissions, salonIds: result.salonIds, effectivePermissions: effectivePermissions(result) };
  });

  server.post("/api/access/invitations", async (request, reply) => {
    const context = await authorize(request, reply, "access.manage");
    if (!context) return;
    const input = inviteSchema.parse(request.body);
    const token = randomBytes(32).toString("base64url");
    try {
      const invitation = await db.$transaction(async (transaction) => {
        await lockTenant(transaction, context.tenant.id);
        const actor = await currentActor(transaction, context);
        const salons = await transaction.salon.findMany({ where: { tenantId: context.tenant.id }, select: { id: true } });
        assertAccessAssignment(actor, undefined, undefined, input, salons.map((salon) => salon.id));
        const email = input.email.toLowerCase();
        const existing = await transaction.tenantMembership.findFirst({ where: { tenantId: context.tenant.id, user: { email } } });
        if (existing) throw new AccessPolicyError("MEMBER_ALREADY_EXISTS", "このメールアドレスは登録済みです。既存メンバーを編集してください。", 409);
        await transaction.tenantInvitation.updateMany({ where: { tenantId: context.tenant.id, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
        const created = await transaction.tenantInvitation.create({ data: { tenantId: context.tenant.id, email, role: input.role,
          useCustomPermissions: input.useCustomPermissions, permissions: [...new Set(input.permissions)], salonIds: input.role === "OWNER" ? [] : [...new Set(input.salonIds)],
          tokenHash: hashInvitationToken(token), expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000), invitedByUserId: context.user.id } });
        await transaction.auditLog.create({ data: auditData(request, context, "access.invitation.create", "tenantInvitation", created.id) });
        // Roll back the new invitation and preserve the previous link if sending fails.
        // Send last so database validation/audit failures cannot trigger a mail.
        await sendInvitation({ email, tenantName: context.tenant.name, role: created.role, expiresAt: created.expiresAt, token });
        return created;
      }, { timeout: 20_000 });
      return reply.code(201).send({ invitation: publicInvitation(invitation), emailSent: true });
    } catch (error) {
      if (error instanceof InvitationEmailError) {
        request.log.warn({ code: error.code }, "invitation email failed");
        return reply.code(503).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  server.delete("/api/access/invitations/:id", async (request, reply) => {
    const context = await authorize(request, reply, "access.manage");
    if (!context) return;
    const { id } = idSchema.parse(request.params);
    await db.$transaction(async (transaction) => {
      await lockTenant(transaction, context.tenant.id);
      const actor = await currentActor(transaction, context);
      const invitation = await transaction.tenantInvitation.findFirst({ where: { id, tenantId: context.tenant.id } });
      if (!invitation) throw new AccessPolicyError("INVITATION_NOT_FOUND", "招待が見つかりません。", 404);
      const salons = await transaction.salon.findMany({ where: { tenantId: context.tenant.id }, select: { id: true } });
      assertAccessAssignment(actor, undefined, invitation, invitation, salons.map((salon) => salon.id));
      if (invitation.acceptedAt) throw new AccessPolicyError("INVITATION_ALREADY_ACCEPTED", "承諾済みの招待は取り消せません。メンバーの利用状態を変更してください。", 409);
      await transaction.tenantInvitation.update({ where: { id }, data: { revokedAt: new Date() } });
      await transaction.auditLog.create({ data: auditData(request, context, "access.invitation.revoke", "tenantInvitation", id) });
    });
    return { revoked: true };
  });

  // This route needs verified identity, but deliberately does not require tenant membership.
  server.post("/api/access/invitations/accept", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const { token } = tokenSchema.parse(request.body);
    const tokenHash = hashInvitationToken(token);
    const initial = await db.tenantInvitation.findUnique({ where: { tokenHash }, select: { tenantId: true } });
    if (!initial) throw new AccessPolicyError("INVITATION_UNAVAILABLE", "この招待を利用できません。", 404);
    const tenant = await db.$transaction(async (transaction) => {
      await lockTenant(transaction, initial.tenantId);
      const invitation = await transaction.tenantInvitation.findUnique({ where: { tokenHash }, include: { tenant: true } });
      if (!invitation || invitation.tenant.status !== "ACTIVE") throw new AccessPolicyError("INVITATION_UNAVAILABLE", "この招待を利用できません。", 410);
      // Keep the shared lock order, and sort when locking two users so invitations
      // in different tenants cannot deadlock by locking the same users in reverse.
      await transaction.$queryRaw`SELECT id FROM "AppUser" WHERE id=${user.id} OR id=${invitation.invitedByUserId} ORDER BY id FOR UPDATE`;
      const currentUser = await transaction.appUser.findUnique({ where: { id: user.id } });
      if (!currentUser || currentUser.disabled || currentUser.email !== user.email) {
        throw new AccessPolicyError("INVITEE_ACCESS_CHANGED", "利用状態またはメールアドレスが変更されています。再ログインしてください。");
      }
      assertInvitationUsable(invitation, currentUser.email);
      const existing = await transaction.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: invitation.tenantId, userId: user.id } } });
      if (existing) throw new AccessPolicyError("MEMBER_ALREADY_EXISTS", "すでに登録されています。管理者に権限の変更を依頼してください。", 409);
      // Recheck the inviter's current authority, preventing an old invite from restoring revoked rights.
      await transaction.$queryRaw`SELECT "userId" FROM "TenantMembership" WHERE "tenantId"=${invitation.tenantId} AND "userId"=${invitation.invitedByUserId} FOR UPDATE`;
      const inviter = await transaction.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: invitation.tenantId, userId: invitation.invitedByUserId } }, include: { user: true } });
      if (!inviter || inviter.user.disabled) throw new AccessPolicyError("INVITER_ACCESS_REVOKED", "招待者の権限が変更されています。新しい招待を依頼してください。", 410);
      const salons = await transaction.salon.findMany({ where: { tenantId: invitation.tenantId }, select: { id: true } });
      assertAccessAssignment(inviter, user.id, undefined, invitation, salons.map((salon) => salon.id));
      const claimed = await transaction.tenantInvitation.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) throw new AccessPolicyError("INVITATION_UNAVAILABLE", "この招待を利用できません。", 410);
      await transaction.tenantMembership.create({ data: { tenantId: invitation.tenantId, userId: user.id, role: invitation.role,
        useCustomPermissions: invitation.useCustomPermissions, permissions: invitation.permissions, salonIds: invitation.role === "OWNER" ? [] : invitation.salonIds, status: "ACTIVE" } });
      await transaction.auditLog.create({ data: { tenantId: invitation.tenantId, actorUserId: user.id, action: "access.invitation.accept", resource: "tenantInvitation", resourceId: invitation.id,
        ipAddress: request.ip, userAgent: request.headers["user-agent"] } });
      return { id: invitation.tenant.id, slug: invitation.tenant.slug, name: invitation.tenant.name };
    });
    return { accepted: true, tenant };
  });

  server.get("/api/access/audit", async (request, reply) => {
    const context = await authorize(request, reply, "audit.read");
    if (!context) return;
    const query = z.object({ action: z.string().trim().max(120).optional(), cursor: z.string().max(100).optional() }).parse(request.query);
    const scoped = context.membership.role !== "OWNER" && context.membership.salonIds.length > 0;
    const records = await db.auditLog.findMany({
      where: { tenantId: context.tenant.id, ...(query.action ? { action: { contains: query.action, mode: "insensitive" } } : {}),
        ...(scoped ? { metadata: { path: ["salonId"], equals: requestedSalonId(request) ?? "" } } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 101,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: { id: true, createdAt: true, action: true, resource: true, resourceId: true, ipAddress: true, actor: { select: { displayName: true, email: true } } }
    });
    return { records: records.slice(0, 100), nextCursor: records.length > 100 ? records[99].id : null };
  });
}
