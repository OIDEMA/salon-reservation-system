import { Prisma } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "./database.js";
import { allowedSalonIds, hasPermission, requirePermission, type Permission } from "./permissions.js";
import { requestedSalonId, type TenantContext } from "./tenant-context.js";

export type OperationContext = TenantContext & { salon: { id: string; name: string; timezone: string } };

export async function requireOperationContext(request: FastifyRequest, reply: FastifyReply, permission: Permission): Promise<OperationContext | null> {
  const context = await requirePermission(request, reply, permission);
  if (!context) return null;
  const salon = await prisma.salon.findFirst({
    where: { tenantId: context.tenant.id, ...(requestedSalonId(request) ? { id: requestedSalonId(request) } : {}) },
    select: { id: true, name: true, timezone: true },
    orderBy: { createdAt: "asc" }
  });
  if (!salon) {
    reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
    return null;
  }
  return { ...context, salon };
}

/** Serialize writes with access changes and recheck the authority inside the transaction. */
export async function lockOperation(
  tx: Prisma.TransactionClient, context: TenantContext & { salon?: { id: string; name?: string; timezone?: string } },
  permission: Permission, salonId = context.salon?.id
): Promise<void> {
  // Lock ordering is shared with access management: tenant first, salon last.
  const tenants = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Tenant" WHERE id=${context.tenant.id} FOR UPDATE`;
  if (!tenants.length) throw operationError(403, "このテナントを利用する権限がありません。");
  // Row locks also detect stale Serializable snapshots after a lock wait, so the
  // transaction retries rather than accepting permissions from an old snapshot.
  await tx.$queryRaw`SELECT id FROM "AppUser" WHERE id=${context.user.id} FOR UPDATE`;
  await tx.$queryRaw`SELECT "userId" FROM "TenantMembership" WHERE "tenantId"=${context.tenant.id} AND "userId"=${context.user.id} FOR UPDATE`;
  const membership = await tx.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId: context.tenant.id, userId: context.user.id } },
    include: { user: true, tenant: true }
  });
  if (!membership || membership.user.disabled || membership.tenant.status !== "ACTIVE" || !hasPermission(membership, permission)) {
    throw operationError(403, "この操作を行う権限がありません。");
  }
  const salonScope = allowedSalonIds(membership);
  if (salonId && salonScope.length && !salonScope.includes(salonId)) {
    throw operationError(403, "この店舗を利用する権限がありません。");
  }
  if (salonId) {
    const salons = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Salon" WHERE "tenantId"=${context.tenant.id} AND id=${salonId} FOR UPDATE`;
    if (!salons.length) throw operationError(404, "店舗が見つかりません。");
    if (context.salon) {
      const salon = await tx.salon.findUnique({ where: { id: salonId }, select: { id: true, name: true, timezone: true } });
      if (salon) Object.assign(context.salon, salon);
    }
  }
  context.membership = membership;
  context.user = membership.user;
  context.tenant = membership.tenant;
}

export async function operationAudit(
  tx: Prisma.TransactionClient, context: TenantContext, request: FastifyRequest,
  event: { action: string; resource: string; resourceId?: string; metadata?: Prisma.InputJsonValue }
) {
  const metadata = event.metadata as Record<string, Prisma.InputJsonValue> ?? {};
  const contextSalonId = "salon" in context ? (context.salon as { id: string } | undefined)?.id : undefined;
  await tx.auditLog.create({ data: {
    tenantId: context.tenant.id, actorUserId: context.user.id,
    ...event, metadata: { ...metadata, salonId: contextSalonId ?? requestedSalonId(request) ?? metadata.salonId ?? null }, ipAddress: request.ip, userAgent: request.headers["user-agent"]
  } });
}

export async function runSerializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 20000 });
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)));
      if (!retryable || attempt >= 3) throw error;
    }
  }
}

export function operationError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
