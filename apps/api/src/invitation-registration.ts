import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Auth, UserRecord } from "firebase-admin/auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { firebaseAdminAuth } from "./auth.js";
import { prisma } from "./database.js";
import { AccessPolicyError, assertAccessAssignment } from "./permissions.js";

export const invitationPreviewSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const invitationRegistrationSchema = invitationPreviewSchema.extend({
  displayName: z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
  // Whitespace can be part of a password. Never trim or normalize it.
  password: z.string().min(8).max(128)
}).strict();

export type RegistrationAuth = Pick<Auth, "createUser" | "getUser" | "getUserByEmail">;
type Transaction = Prisma.TransactionClient;
type Action = "preview" | "register";
type Dependencies = { database?: PrismaClient; auth?: RegistrationAuth; now?: () => number };
const windowMs = 10 * 60_000;
const unavailable = () => new AccessPolicyError("INVITATION_UNAVAILABLE", "この招待は期限切れ、取消済み、承諾済み、または利用できない状態です。新しい招待を依頼してください。", 410);
const accountExists = () => new AccessPolicyError("INVITATION_ACCOUNT_EXISTS", "このメールアドレスは登録済みです。ログインして招待を承諾してください。", 409);
const registrationUnavailable = () => new AccessPolicyError("INVITATION_REGISTRATION_UNAVAILABLE", "登録処理を確認できませんでした。アカウント作成が完了している場合があります。同じメールアドレスとパスワードでログインし、招待を承諾してください。", 503);
const rateLimited = () => new AccessPolicyError("INVITATION_RATE_LIMIT", "操作が続いています。時間を置いて再度お試しください。", 429);
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const tenantResult = (tenant: { id: string; slug: string; name: string }) => ({ id: tenant.id, slug: tenant.slug, name: tenant.name });

/** Early, bounded protection for malformed/unknown tokens, without persisting user input. */
export function invitationRequestLimiter(now = Date.now, limit = 100, maxEntries = 4096) {
  const entries = new Map<string, { startsAt: number; count: number }>();
  return (ip: string) => {
    const current = now();
    for (const [key, entry] of entries) if (current - entry.startsAt >= 60_000) entries.delete(key);
    let entry = entries.get(ip);
    if (!entry) {
      if (entries.size >= maxEntries) throw rateLimited();
      entry = { startsAt: current, count: 0 };
      entries.set(ip, entry);
    }
    if (++entry.count > limit) throw rateLimited();
  };
}

function authErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
}

async function lookupByEmail(auth: RegistrationAuth, email: string): Promise<UserRecord | null> {
  try { return await auth.getUserByEmail(email); }
  catch (error) {
    if (authErrorCode(error) === "auth/user-not-found") return null;
    throw registrationUnavailable();
  }
}

/** Caller holds the tenant lock. Recheck current sender authority, not just the signed invitation. */
async function validInvitation(tx: Transaction, tenantId: string, tokenHash: string, candidateUid?: string) {
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${tenantId} FOR UPDATE`;
  const invitation = await tx.tenantInvitation.findUnique({ where: { tokenHash }, include: { tenant: true } });
  if (!invitation || invitation.tenantId !== tenantId || invitation.tenant.status !== "ACTIVE"
    || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) throw unavailable();

  // Match the accept endpoint's Tenant -> sorted AppUser -> Membership lock order.
  // Also lock an existing email owner, so no legacy AppUser can be rebound to a new UID.
  const email = invitation.email.toLowerCase();
  await tx.$queryRaw`SELECT id FROM "AppUser" WHERE id=${invitation.invitedByUserId}
    OR "firebaseUid"=${candidateUid ?? ""} OR lower(email)=${email} ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT "userId" FROM "TenantMembership" WHERE "tenantId"=${tenantId}
    AND "userId"=${invitation.invitedByUserId} FOR UPDATE`;
  const inviter = await tx.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId, userId: invitation.invitedByUserId } }, include: { user: true }
  });
  if (!inviter || inviter.user.disabled || inviter.status !== "ACTIVE") throw unavailable();
  const salons = await tx.salon.findMany({ where: { tenantId }, select: { id: true } });
  try { assertAccessAssignment(inviter, undefined, undefined, invitation, salons.map((salon) => salon.id)); }
  catch (error) { if (error instanceof AccessPolicyError) throw unavailable(); throw error; }
  return invitation;
}

async function consumeInvitationLimit(tx: Transaction, invitationId: string, action: Action, now: number) {
  const key = { invitationId, action };
  const startsAt = new Date(Math.floor(now / windowMs) * windowMs);
  const current = await tx.invitationRequestLimit.findUnique({ where: { invitationId_action: key } });
  const attempts = current?.windowStartsAt.getTime() === startsAt.getTime() ? current.attempts : 0;
  if (attempts >= (action === "register" ? 10 : 60)) throw rateLimited();
  await tx.invitationRequestLimit.upsert({ where: { invitationId_action: key },
    create: { ...key, windowStartsAt: startsAt, attempts: 1 }, update: { windowStartsAt: startsAt, attempts: attempts + 1 } });
}

async function preflight(db: PrismaClient, tokenHash: string, action: Action, now: () => number) {
  const initial = await db.tenantInvitation.findUnique({ where: { tokenHash }, select: { tenantId: true } });
  if (!initial) throw unavailable();
  return db.$transaction(async (tx) => {
    const invitation = await validInvitation(tx, initial.tenantId, tokenHash);
    await consumeInvitationLimit(tx, invitation.id, action, now());
    const existing = await tx.appUser.findFirst({ where: { email: { equals: invitation.email, mode: "insensitive" } }, select: { id: true } });
    return { invitation, existing: Boolean(existing) };
  }, { maxWait: 5000, timeout: 10_000 });
}

export async function createInvitedIdentity(auth: RegistrationAuth, email: string, displayName: string, password: string, uid: string) {
  try {
    const user = await auth.createUser({ uid, email, displayName, password, emailVerified: true, disabled: false });
    if (user.uid !== uid || user.email?.toLowerCase() !== email || !user.emailVerified || user.disabled) throw registrationUnavailable();
    return;
  } catch (error) {
    if (authErrorCode(error) === "auth/email-already-exists") throw accountExists();
    // A timeout may occur after Firebase has created the account. Only this
    // request's unpredictable UID can prove ownership of that partial result.
    try {
      const user = await auth.getUser(uid);
      if (user.uid === uid && user.email?.toLowerCase() === email && user.emailVerified && !user.disabled) return;
    } catch { /* Unknown outcome: keep the identity, if any, for normal login + accept recovery. */ }
    throw registrationUnavailable();
  }
}

async function commitRegistration(db: PrismaClient, tokenHash: string, tenantId: string, uid: string, email: string,
  displayName: string, request: FastifyRequest) {
  // A concurrent first login may create this exact UID's AppUser after our
  // initial read. Retry the unique-key race once, then safely reuse that row.
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const invitation = await validInvitation(tx, tenantId, tokenHash, uid);
        if (invitation.email.toLowerCase() !== email) throw unavailable();
        const owner = await tx.appUser.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
        const candidate = await tx.appUser.findUnique({ where: { firebaseUid: uid } });
        if ((owner && owner.firebaseUid !== uid) || (candidate && (candidate.disabled || candidate.email?.toLowerCase() !== email))) throw accountExists();
        const user = candidate ?? await tx.appUser.create({ data: { firebaseUid: uid, email, displayName } });
        if (user.id === invitation.invitedByUserId) throw unavailable();
        const existing = await tx.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId, userId: user.id } } });
        if (existing) throw accountExists();
        const claimed = await tx.tenantInvitation.updateMany({
          where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date() }
        });
        if (claimed.count !== 1) throw unavailable();
        await tx.tenantMembership.create({ data: { tenantId, userId: user.id, role: invitation.role, status: "ACTIVE",
          useCustomPermissions: invitation.useCustomPermissions, permissions: invitation.permissions,
          salonIds: invitation.role === "OWNER" ? [] : invitation.salonIds } });
        await tx.auditLog.create({ data: { tenantId, actorUserId: user.id, action: "access.invitation.register",
          resource: "tenantInvitation", resourceId: invitation.id, ipAddress: request.ip, userAgent: request.headers["user-agent"] } });
        return tenantResult(invitation.tenant);
      }, { maxWait: 5000, timeout: 10_000 });
    } catch (error) {
      if (attempt < 1 && ["P2002", "P2034"].includes(authErrorCode(error) ?? "")) continue;
      throw error;
    }
  }
}

/** A lost COMMIT response must not report failure (or delete a valid account). */
async function confirmedRegistration(db: PrismaClient, invitationId: string, tenantId: string, uid: string, email: string) {
  const user = await db.appUser.findUnique({ where: { firebaseUid: uid }, include: {
    memberships: { where: { tenantId, status: "ACTIVE", tenant: { status: "ACTIVE" } }, include: { tenant: true } }
  } });
  if (!user || user.disabled || user.email?.toLowerCase() !== email || user.memberships.length !== 1) return null;
  const [invitation, audit] = await Promise.all([
    db.tenantInvitation.findUnique({ where: { id: invitationId }, select: { acceptedAt: true, tenantId: true } }),
    db.auditLog.findFirst({ where: { tenantId, actorUserId: user.id, action: "access.invitation.register", resource: "tenantInvitation", resourceId: invitationId }, select: { id: true } })
  ]);
  return invitation?.acceptedAt && invitation.tenantId === tenantId && audit ? tenantResult(user.memberships[0].tenant) : null;
}

function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  // Never log Firebase/Prisma exception objects: they may contain credentials or request data.
  if (error instanceof z.ZodError) return reply.code(400).send({ code: "INVALID_INPUT", message: "招待リンクと入力内容を確認してください。" });
  const safe = error instanceof AccessPolicyError && ["INVITATION_UNAVAILABLE", "INVITATION_ACCOUNT_EXISTS", "INVITATION_RATE_LIMIT", "INVITATION_REGISTRATION_UNAVAILABLE"].includes(error.code)
    ? error : registrationUnavailable();
  if (safe.statusCode === 429) reply.header("Retry-After", "600");
  if (safe.statusCode >= 500) request.log.warn({ code: safe.code }, "invitation registration requires retry or login recovery");
  return reply.code(safe.statusCode).send({ code: safe.code, message: safe.message });
}

export function registerInvitationRegistrationRoutes(server: FastifyInstance, dependencies: Dependencies = {}) {
  const db = dependencies.database ?? prisma;
  const auth = dependencies.auth ?? firebaseAdminAuth;
  const now = dependencies.now ?? Date.now;
  const limitRequest = invitationRequestLimiter(now);
  for (const action of ["preview", "register"] as const) {
    server.post(`/api/access/invitations/${action}`, { bodyLimit: 4096 }, async (request, reply) => {
      reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
      try {
        limitRequest(request.ip);
        const input = action === "register" ? invitationRegistrationSchema.parse(request.body) : invitationPreviewSchema.parse(request.body);
        const tokenHash = hashToken(input.token);
        const { invitation, existing } = await preflight(db, tokenHash, action, now);
        const email = invitation.email.toLowerCase();
        const exists = existing || Boolean(await lookupByEmail(auth, email));
        if (action === "preview") return { email, tenant: tenantResult(invitation.tenant), role: invitation.role, alreadyRegistered: exists };
        if (exists) throw accountExists();
        const registration = input as z.infer<typeof invitationRegistrationSchema>;
        const uid = `invite-${randomUUID()}`;
        // The mailbox-delivered, single-use invitation proves control of this
        // exact email. Identity creation never accepts a caller-supplied email/UID.
        await createInvitedIdentity(auth, email, registration.displayName, registration.password, uid);
        try {
          const tenant = await commitRegistration(db, tokenHash, invitation.tenantId, uid, email, registration.displayName, request);
          return reply.code(201).send({ registered: true, tenant });
        } catch (error) {
          const committed = await confirmedRegistration(db, invitation.id, invitation.tenantId, uid, email);
          if (committed) return reply.code(201).send({ registered: true, tenant: committed });
          // No compensation delete: SQL commit may be ambiguous and the same
          // identity can already have signed in or accepted another invitation.
          if (error instanceof AccessPolicyError) throw error;
          throw registrationUnavailable();
        }
      } catch (error) { return sendError(error, request, reply); }
    });
  }
}
