import type { AppUser, Tenant, TenantMembership, TenantRole } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "./database.js";
import { verifyFirebaseCredential } from "./auth.js";
import { isTenantSlug } from "./tenant-slug.js";

export type AuthenticatedUser = AppUser;

export type TenantContext = {
  tenant: Tenant;
  membership: TenantMembership;
  user: AppUser;
};

export async function requireAuthenticatedUser(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null> {
  let claims: Awaited<ReturnType<typeof verifyFirebaseCredential>>;
  try {
    claims = await verifyFirebaseCredential(request.headers.authorization);
  } catch {
    reply.code(401).send({ code: "UNAUTHENTICATED", message: "ログインが必要です。" });
    return null;
  }

  if (!claims.email || claims.email_verified !== true) {
    reply.code(403).send({ code: "EMAIL_NOT_VERIFIED", message: "メールアドレスの確認が必要です。" });
    return null;
  }

  const user = await prisma.appUser.upsert({
    where: { firebaseUid: claims.uid },
    create: {
      firebaseUid: claims.uid,
      email: claims.email.toLowerCase(),
      displayName: claims.name,
      lastSignedInAt: new Date()
    },
    update: {
      email: claims.email.toLowerCase(),
      displayName: claims.name,
      lastSignedInAt: new Date()
    }
  });

  if (user.disabled) {
    reply.code(403).send({ code: "USER_DISABLED", message: "このユーザーは利用停止中です。" });
    return null;
  }

  return user;
}

export async function requireTenantContext(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles?: TenantRole[]
): Promise<TenantContext | null> {
  const user = await requireAuthenticatedUser(request, reply);
  if (!user) return null;

  const tenantSlugHeader = request.headers["x-tenant-slug"];
  const tenantSlug = Array.isArray(tenantSlugHeader) ? tenantSlugHeader[0] : tenantSlugHeader;
  const tenantIdHeader = request.headers["x-tenant-id"];
  const tenantId = Array.isArray(tenantIdHeader) ? tenantIdHeader[0] : tenantIdHeader;
  if (!tenantSlug && !tenantId) {
    reply.code(400).send({ code: "TENANT_REQUIRED", message: "利用するテナントを選択してください。" });
    return null;
  }
  if (tenantSlug && !isTenantSlug(tenantSlug)) {
    reply.code(400).send({ code: "INVALID_TENANT_SLUG", message: "テナントURLが正しくありません。" });
    return null;
  }

  const membership = tenantSlug
    ? await prisma.tenantMembership.findFirst({
        where: { userId: user.id, tenant: { slug: tenantSlug } },
        include: { tenant: true }
      })
    : await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: tenantId!, userId: user.id } },
        include: { tenant: true }
      });

  if (!membership || membership.status !== "ACTIVE" || membership.tenant.status !== "ACTIVE") {
    reply.code(403).send({ code: "TENANT_ACCESS_DENIED", message: "このテナントを利用する権限がありません。" });
    return null;
  }

  if (allowedRoles && !allowedRoles.includes(membership.role)) {
    reply.code(403).send({ code: "ROLE_ACCESS_DENIED", message: "この操作を行う権限がありません。" });
    return null;
  }

  return { tenant: membership.tenant, membership, user };
}

export function requestedSalonId(request: FastifyRequest) {
  const value = request.headers["x-salon-id"];
  return Array.isArray(value) ? value[0] : value;
}
