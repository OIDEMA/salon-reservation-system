import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { requireAuthenticatedUser } from "./tenant-context.js";
import { effectivePermissions, allowedSalonIds, hasPermission } from "./permissions.js";
import { requireOperationContext, lockOperation, operationAudit } from "./operations-support.js";
import { MembershipError, membershipAssert, membershipSafeError } from "./membership-domain.js";
import { isTenantSlug } from "./tenant-slug.js";

const targetSchema = z.object({
  date: z.string().date(), page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(1).max(30).default(20), customerId: z.string().min(1).max(160).optional(),
}).strict();
type Context = NonNullable<Awaited<ReturnType<typeof requireOperationContext>>>;

/** Use the verified actor, not a caller-supplied program/tenant/barcode, as the
 * counter key. The existing counter table has no untrusted-identifier fanout. */
async function consumeNativeAttempt(userId: string) {
  const actorKey = `native-staff:${userId}`, programId = "staff-native-context";
  const now = Date.now(), windowStartsAt = new Date(Math.floor(now / 600_000) * 600_000);
  const key = { actorKey, programId, windowStartsAt };
  const result = await prisma.membershipLookupRateLimit.upsert({ where: { actorKey_programId_windowStartsAt: key },
    create: { ...key, attempts: 1 }, update: { attempts: { increment: 1 } } });
  await prisma.membershipLookupRateLimit.deleteMany({ where: { actorKey, programId, windowStartsAt: { lt: new Date(now - 86_400_000) } } });
  membershipAssert(result.attempts <= 120, "STAFF_MOBILE_RATE_LIMIT", "操作が集中しています。時間をおいて再試行してください。", 429);
}
async function nativeContext(request: FastifyRequest, reply: FastifyReply): Promise<Context | null> {
  const slug = request.headers["x-tenant-slug"], salonId = request.headers["x-salon-id"];
  if (typeof slug !== "string" || !isTenantSlug(slug) || typeof salonId !== "string" || !salonId.length || salonId.length > 160) {
    reply.code(400).send({ code: "STAFF_SCOPE_REQUIRED", message: "利用する会社と店舗を選択してください。" }); return null;
  }
  const context = await requireOperationContext(request, reply, "checkout.read");
  if (!context) return null;
  // Headers select a scope; current DB membership and salon grants authorize it.
  const tenantId = request.headers["x-tenant-id"];
  if (tenantId !== undefined && tenantId !== context.tenant.id) {
    reply.code(403).send({ code: "STAFF_SCOPE_MISMATCH", message: "利用する会社と店舗を選択し直してください。" }); return null;
  }
  return context;
}
async function serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 20000 }); }
    catch (error) {
      const retry = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" ||
        error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)));
      if (!retry) throw error;
      if (attempt >= 5) throw new MembershipError("STAFF_MOBILE_BUSY", "別の操作が行われています。最新の状態を取得し直してください。", 409);
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 20 * 2 ** attempt)));
    }
  }
}
const japanDate = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const japanTime = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);

/** Native staff uses the same Firebase credential and DB grants as Salon
 * Reserve. This module never exposes an independent point-award/debit route. */
export function registerStaffMobileRoutes(server: FastifyInstance) {
  server.register(async (mobile) => {
    mobile.addHook("preHandler", async (_request, reply) => { reply.header("Cache-Control", "private, no-store").header("Pragma", "no-cache"); });
    mobile.setErrorHandler((error, _request, reply) => { const safe = membershipSafeError(error); return reply.code(safe.status).send({ code: safe.code, message: safe.message }); });

    mobile.get("/api/staff/mobile/context", async (request, reply) => {
      z.object({}).strict().parse(request.query);
      const user = await requireAuthenticatedUser(request, reply); if (!user) return;
      await consumeNativeAttempt(user.id);
      const memberships = await prisma.tenantMembership.findMany({
        where: { userId: user.id, status: "ACTIVE", user: { disabled: false }, tenant: { status: "ACTIVE" } },
        select: { role: true, status: true, useCustomPermissions: true, permissions: true, salonIds: true,
          tenant: { select: { id: true, slug: true, name: true, membershipProgram: { select: { id: true, name: true, active: true } },
            salons: { select: { id: true, name: true, timezone: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } } },
        orderBy: [{ createdAt: "asc" }, { tenantId: "asc" }],
      });
      const tenants = memberships.map((membership) => {
        const allowed = allowedSalonIds(membership);
        return { id: membership.tenant.id, slug: membership.tenant.slug, name: membership.tenant.name, role: membership.role,
          permissions: effectivePermissions(membership), program: membership.tenant.membershipProgram,
          salons: membership.tenant.salons.filter((salon) => !allowed.length || allowed.includes(salon.id)) };
      });
      if (tenants.length) await prisma.auditLog.createMany({ data: tenants.map((tenant) => ({
        tenantId: tenant.id, actorUserId: user.id, action: "staff.mobile.context", resource: "tenant", resourceId: tenant.id,
        metadata: { salonCount: tenant.salons.length }, ipAddress: request.ip, userAgent: request.headers["user-agent"],
      })) });
      return { staff: { id: user.id, displayName: user.displayName ?? "スタッフ" }, tenants };
    });

    mobile.post("/api/staff/mobile/targets", async (request, reply) => {
      const context = await nativeContext(request, reply); if (!context) return;
      const input = targetSchema.parse(request.body);
      await consumeNativeAttempt(context.user.id);
      membershipAssert(context.salon.timezone === "Asia/Tokyo", "STAFF_TIMEZONE_UNSUPPORTED", "この店舗の営業日時はサロンシステムでご確認ください。", 409);
      const startsAt = new Date(`${input.date}T00:00:00+09:00`), endsAt = new Date(startsAt.getTime() + 86_400_000);
      return serializable(async (tx) => {
        await lockOperation(tx, context, "checkout.read");
        const canReadReservations = hasPermission(context, "reservation.read");
        const capabilities = { canReadReservations, canWriteCheckouts: hasPermission(context, "checkout.write"), canLinkCustomers: hasPermission(context, "customer.write") };
        const scope = { tenantId: context.tenant.id, salonId: context.salon.id };
        const reservationWhere = { ...scope, startsAt: { gte: startsAt, lt: endsAt }, ...(input.customerId ? { customerId: input.customerId } : {}) };
        const skip = (input.page - 1) * input.pageSize;
        let total: number;
        let targets: Array<{ customer: { id: string; name: string }; reservation: null | {
          id: string; startsAt: string; date: string; startTime: string; serviceName: string; status: string; paymentStatus: string;
        }; checkout: null | { id: string; reservationId: string; status: string; totalYen: number; version: number; membershipAccountId: string | null } }>;
        if (canReadReservations) {
          total = await tx.reservation.count({ where: reservationWhere });
          const reservations = await tx.reservation.findMany({ where: reservationWhere,
            select: { id: true, startsAt: true, status: true, paymentStatus: true, customer: { select: { id: true, name: true } }, service: { select: { name: true } },
              cashCheckouts: { where: { status: { not: "REVERSED" } }, select: { id: true, reservationId: true, status: true, totalYen: true, version: true, membershipAccountId: true },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } },
            orderBy: [{ startsAt: "asc" }, { id: "asc" }], skip, take: input.pageSize });
          targets = reservations.map((reservation) => ({ customer: reservation.customer,
            reservation: { id: reservation.id, startsAt: reservation.startsAt.toISOString(), date: japanDate(reservation.startsAt), startTime: japanTime(reservation.startsAt),
              serviceName: reservation.service.name, status: reservation.status, paymentStatus: reservation.paymentStatus }, checkout: reservation.cashCheckouts[0] ?? null }));
        } else {
          const where = { ...scope, reservation: reservationWhere };
          total = await tx.cashCheckout.count({ where });
          const checkouts = await tx.cashCheckout.findMany({ where,
            select: { id: true, reservationId: true, status: true, totalYen: true, version: true, membershipAccountId: true,
              reservation: { select: { customer: { select: { id: true, name: true } } } } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip, take: input.pageSize });
          targets = checkouts.map(({ reservation, ...checkout }) => ({ customer: reservation.customer, reservation: null, checkout }));
        }
        await operationAudit(tx, context, request, { action: "staff.mobile.targets", resource: "salon", resourceId: context.salon.id, metadata: { date: input.date, page: input.page, pageSize: input.pageSize } });
        return { date: input.date, page: input.page, pageSize: input.pageSize, total, capabilities, targets };
      });
    });
  });
}
