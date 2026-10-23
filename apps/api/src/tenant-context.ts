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

// The permission hook and the route handler share one request. Reuse only that
// request's successful checks; every new HTTP request still verifies revocation
// and reads the current user, membership, tenant and salon from the database.
const authenticatedUsers = new WeakMap<FastifyRequest, { authorization: string | undefined; user: AuthenticatedUser }>();
type ContextScope = { authorization: string | undefined; tenantSlug: string | undefined; tenantId: string | undefined; salonId: string | undefined };
const tenantContexts = new WeakMap<FastifyRequest, { scope: ContextScope; context: TenantContext }>();

function contextScope(request: FastifyRequest): ContextScope {
  const slug = request.headers["x-tenant-slug"];
  const tenant = request.headers["x-tenant-id"];
  return { authorization: request.headers.authorization,
    tenantSlug: Array.isArray(slug) ? slug[0] : slug,
    tenantId: Array.isArray(tenant) ? tenant[0] : tenant,
    salonId: requestedSalonId(request) };
}

function sameScope(left: ContextScope, right: ContextScope) {
  return left.authorization === right.authorization && left.tenantSlug === right.tenantSlug &&
    left.tenantId === right.tenantId && left.salonId === right.salonId;
}

function roleAllowed(context: TenantContext, reply: FastifyReply, allowedRoles?: TenantRole[]) {
  if (allowedRoles && !allowedRoles.includes(context.membership.role)) {
    reply.code(403).send({ code: "ROLE_ACCESS_DENIED", message: "この操作を行う権限がありません。" });
    return false;
  }
  return true;
}

export async function requireAuthenticatedUser(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null> {
  const authorization = request.headers.authorization;
  const cached = authenticatedUsers.get(request);
  if (cached && cached.authorization === authorization) return cached.user;
  authenticatedUsers.delete(request);
  tenantContexts.delete(request);
  let claims: Awaited<ReturnType<typeof verifyFirebaseCredential>>;
  try {
    claims = await verifyFirebaseCredential(authorization);
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

  // An internal asynchronous hook must not associate a different credential
  // with the identity that was actually verified.
  if (request.headers.authorization !== authorization) {
    reply.code(401).send({ code: "UNAUTHENTICATED", message: "ログインが必要です。" });
    return null;
  }
  authenticatedUsers.set(request, { authorization, user });
  return user;
}

export async function requireTenantContext(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles?: TenantRole[]
): Promise<TenantContext | null> {
  const user = await requireAuthenticatedUser(request, reply);
  if (!user) return null;

  const scopeKey = contextScope(request);
  const cached = tenantContexts.get(request);
  if (cached && sameScope(cached.scope, scopeKey)) {
    return roleAllowed(cached.context, reply, allowedRoles) ? cached.context : null;
  }
  // Header changes must resolve their own scope, even when an earlier scope was
  // allowed. Do not retain an earlier success after a failed scope change.
  tenantContexts.delete(request);
  const { tenantSlug, tenantId } = scopeKey;
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

  const context = { tenant: membership.tenant, membership, user };
  if (!roleAllowed(context, reply, allowedRoles)) return null;

  // Resolve the salon before legacy handlers apply their first-salon fallback.
  const scope = membership.role === "OWNER" ? [] : membership.salonIds;
  const selectedSalonId = requestedSalonId(request);
  const salon = await prisma.salon.findFirst({
    where: {
      tenantId: membership.tenantId,
      ...(selectedSalonId ? { id: selectedSalonId } : {}),
      ...(scope.length ? { id: selectedSalonId && scope.includes(selectedSalonId) ? selectedSalonId : { in: scope } } : {})
    },
    orderBy: { createdAt: "asc" }
  });
  if ((selectedSalonId && (scope.length && !scope.includes(selectedSalonId) || salon?.id !== selectedSalonId)) ||
    (scope.length && !salon)) {
    reply.code(403).send({ code: "SALON_ACCESS_DENIED", message: "この店舗を利用する権限がありません。" });
    return null;
  }
  if (salon) request.headers["x-salon-id"] = salon.id;

  // Store the normalized salon header so the route reuses the same authorized
  // salon chosen by its permission hook when no explicit salon was supplied.
  tenantContexts.set(request, { scope: contextScope(request), context });
  return context;
}

export function requestedSalonId(request: FastifyRequest) {
  const value = request.headers["x-salon-id"];
  return Array.isArray(value) ? value[0] : value;
}
