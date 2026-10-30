import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { requireMemberIdentity } from "./member-auth.js";
import { publishedMemberTenants, type MemberIdentity } from "./member-booking-domain.js";
import { requireOperationContext, lockOperation, operationAudit } from "./operations-support.js";
import {
  MEMBERSHIP_POLICY, MembershipError, membershipAssert, membershipBalance,
  membershipEnrollmentSchema, membershipLinkSchema, membershipLookupSchema,
  membershipSafeError, parseMembershipBarcode, requireMembershipProgram,
} from "./membership-domain.js";

type Tx = Prisma.TransactionClient;
type Context = NonNullable<Awaited<ReturnType<typeof requireOperationContext>>>;
type Dependencies = {
  database?: PrismaClient; authenticateMember?: typeof requireMemberIdentity;
  authorize?: typeof requireOperationContext; lock?: typeof lockOperation; now?: () => Date;
};
const customerParams = z.object({ id: z.string().min(1).max(160) }).strict();
const kindLabels = { EARN: "来店ポイント", REDEEM: "ポイント利用", REFUND: "利用ポイント返還", EARN_REVERSAL: "付与ポイント取消" } as const;

async function serializable<T>(database: PrismaClient, operation: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await database.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 20000 }); }
    catch (error) {
      const retry = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002" || error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)));
      if (!retry) throw error;
      if (attempt >= 5) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw error;
        throw new MembershipError("MEMBERSHIP_BUSY", "別の操作が行われています。最新の状態を確認して再試行してください。", 409);
      }
      // These PostgreSQL errors have rolled back the complete transaction. A
      // short backoff avoids repeatedly colliding with the same checkout/link.
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 20 * 2 ** attempt)));
    }
  }
}
async function consumeAttempt(database: PrismaClient, actorKey: string, programId: string, now: Date) {
  const windowStartsAt = new Date(Math.floor(now.getTime() / 600_000) * 600_000);
  const rate = await database.membershipLookupRateLimit.upsert({ where: { actorKey_programId_windowStartsAt: { actorKey, programId, windowStartsAt } },
    create: { actorKey, programId, windowStartsAt, attempts: 1 }, update: { attempts: { increment: 1 } } });
  await database.membershipLookupRateLimit.deleteMany({ where: { actorKey, programId, windowStartsAt: { lt: new Date(now.getTime() - 86_400_000) } } });
  membershipAssert(rate.attempts <= 120, "MEMBERSHIP_RATE_LIMIT", "操作が集中しています。時間をおいて再試行してください。", 429);
}
const scope = (context: Context) => ({ tenantId: context.tenant.id, salonId: context.salon.id });
async function receptionDto(tx: Tx, context: Context, programId: string, accountId: string, customerId: string | null) {
  const account = await tx.membershipAccount.findFirst({ where: { id: accountId, programId, active: true } });
  membershipAssert(account, "MEMBERSHIP_NOT_FOUND", "会員情報が見つかりません。会員証をご確認ください。", 404);
  const [ownLink, targetLink, totals, entries] = await Promise.all([
    tx.membershipCustomerLink.findFirst({ where: { ...scope(context), programId, accountId: account.id } }),
    customerId ? tx.membershipCustomerLink.findFirst({ where: { ...scope(context), customerId } }) : null,
    membershipBalance(tx, account.id, programId),
    tx.membershipPointEntry.findMany({ where: { ...scope(context), programId, accountId: account.id },
      include: { salon: { select: { name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 }),
  ]);
  const mismatched = Boolean(customerId && (ownLink && ownLink.customerId !== customerId || targetLink && targetLink.accountId !== account.id));
  const linkStatus = mismatched ? "MISMATCH" : ownLink && (!customerId || ownLink.customerId === customerId) ? "LINKED" : "UNLINKED";
  return { member: { id: account.id, number: account.memberNumber, name: account.displayName, ...totals },
    linkStatus, customerId: customerId ?? ownLink?.customerId ?? null, policy: MEMBERSHIP_POLICY,
    history: entries.map((entry) => ({ id: entry.id, kind: entry.kind, delta: entry.delta, createdAt: entry.createdAt.toISOString(), salonName: entry.salon.name, checkoutId: entry.checkoutId })) };
}
async function targetCustomer(tx: Tx, context: Context, input: { checkoutId?: string; reservationId?: string }) {
  if (input.checkoutId) {
    const checkout = await tx.cashCheckout.findFirst({ where: { ...scope(context), id: input.checkoutId }, select: { reservation: { select: { customerId: true } } } });
    membershipAssert(checkout, "CHECKOUT_NOT_FOUND", "会計が見つかりません。", 404);
    return checkout.reservation.customerId;
  }
  if (input.reservationId) {
    const reservation = await tx.reservation.findFirst({ where: { ...scope(context), id: input.reservationId }, select: { customerId: true } });
    membershipAssert(reservation, "RESERVATION_NOT_FOUND", "予約が見つかりません。", 404);
    return reservation.customerId;
  }
  return null;
}
async function memberDto(database: PrismaClient | Tx, identity: MemberIdentity, programId: string) {
  const publication = publishedMemberTenants();
  const account = await database.membershipAccount.findUnique({ where: { programId_projectId_uid: { programId, ...identity } }, include: { program: {
    include: { tenant: { select: { slug: true, name: true, status: true } } },
  } } });
  membershipAssert(account, "MEMBERSHIP_NOT_REGISTERED", "この会員プログラムへの登録が必要です。", 404);
  const [totals, entries, checkouts] = await Promise.all([
    membershipBalance(database, account.id, programId),
    database.membershipPointEntry.findMany({ where: { programId, accountId: account.id }, include: { salon: { select: { name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 51 }),
    database.cashCheckout.findMany({ where: { membershipAccountId: account.id, status: { in: ["FINALIZED", "REVERSED"] } },
      include: { salon: { select: { name: true, tenant: { select: { slug: true } } } } },
      orderBy: [{ finalizedAt: "desc" }, { id: "desc" }], take: 51 }),
  ]);
  const tenant = account.program.tenant;
  const publicTenants = tenant?.status === "ACTIVE" && publication.has(tenant.slug)
    ? [{ slug: tenant.slug, name: tenant.name, brandId: publication.get(tenant.slug)! }] : [];
  const active = account.active && account.program.active && publicTenants.length > 0;
  return { program: { id: account.program.id, name: account.program.name, pointPolicy: MEMBERSHIP_POLICY,
      publicTenants, brands: [...new Set(publicTenants.map((tenant) => tenant.brandId))], enrolled: true, canEnroll: active },
    member: { id: account.id, number: account.memberNumber, name: account.displayName, active }, ...totals,
    availablePoints: active ? totals.availablePoints : 0,
    transactions: entries.slice(0, 50).map((entry) => ({ id: entry.id, date: entry.createdAt.toISOString(), description: `${entry.salon.name} ${kindLabels[entry.kind]}`,
      amount: entry.delta, kind: entry.kind, ...(entry.checkoutId ? { visitId: entry.checkoutId } : {}) })),
    visits: checkouts.slice(0, 50).map((checkout) => {
      const snapshot = checkout.reservationSnapshot as Record<string, unknown>;
      return { id: checkout.id, salonId: checkout.salonId, salonName: checkout.salon.name,
        brandId: publication.get(checkout.salon.tenant.slug) ?? null, date: checkout.finalizedAt!.toISOString(),
        treatment: typeof snapshot.serviceName === "string" ? snapshot.serviceName : "ご来店", points: checkout.pointsAwarded,
        amountYen: checkout.totalYen, status: checkout.status };
    }), historyComplete: entries.length <= 50 && checkouts.length <= 50 };
}

export function registerMembershipRoutes(server: FastifyInstance, dependencies: Dependencies = {}) {
  const database = dependencies.database ?? prisma;
  const authorize = dependencies.authorize ?? requireOperationContext;
  const lock = dependencies.lock ?? lockOperation;
  const authenticate = dependencies.authenticateMember ?? requireMemberIdentity;
  const now = dependencies.now ?? (() => new Date());
  server.register(async (staff) => {
    staff.addHook("preHandler", async (_request, reply) => { reply.header("Cache-Control", "private, no-store").header("Pragma", "no-cache"); });
    staff.setErrorHandler((error, _request, reply) => { const safe = membershipSafeError(error); return reply.code(safe.status).send({ code: safe.code, message: safe.message }); });

    staff.post("/api/membership/lookup", async (request, reply) => {
      const input = membershipLookupSchema.parse(request.body);
      const permission = input.checkoutId ? "checkout.write" : "customer.read";
      const context = await authorize(request, reply, permission); if (!context) return;
      const program = await requireMembershipProgram(database, context.tenant.id);
      await consumeAttempt(database, `staff:${context.user.id}`, program.id, now());
      const number = parseMembershipBarcode(input.barcode);
      return serializable(database, async (tx) => {
        await lock(tx, context, permission);
        const currentProgram = await requireMembershipProgram(tx, context.tenant.id);
        membershipAssert(currentProgram.id === program.id, "MEMBERSHIP_UNAVAILABLE", "会員システムの設定が更新されました。読み取り直してください。", 409);
        const account = await tx.membershipAccount.findFirst({ where: { programId: program.id, memberNumber: number, active: true }, select: { id: true } });
        membershipAssert(account, "MEMBERSHIP_NOT_FOUND", "会員情報が見つかりません。会員証をご確認ください。", 404);
        const customerId = await targetCustomer(tx, context, input);
        const result = await receptionDto(tx, context, program.id, account.id, customerId);
        await operationAudit(tx, context, request, { action: "membership.lookup", resource: "membershipAccount", resourceId: account.id, metadata: { programId: program.id } });
        return result;
      });
    });

    staff.post("/api/admin/customers/:id/membership-link", async (request, reply) => {
      const context = await authorize(request, reply, "customer.write"); if (!context) return;
      const { id } = customerParams.parse(request.params); const input = membershipLinkSchema.parse(request.body);
      const program = await requireMembershipProgram(database, context.tenant.id);
      await consumeAttempt(database, `staff:${context.user.id}`, program.id, now());
      const number = parseMembershipBarcode(input.barcode);
      return serializable(database, async (tx) => {
        await lock(tx, context, "customer.write");
        const currentProgram = await requireMembershipProgram(tx, context.tenant.id);
        membershipAssert(currentProgram.id === program.id, "MEMBERSHIP_UNAVAILABLE", "会員システムの設定が更新されました。読み取り直してください。", 409);
        const customer = await tx.customer.findFirst({ where: { ...scope(context), id }, select: { id: true } });
        membershipAssert(customer, "CUSTOMER_NOT_FOUND", "お客様が見つかりません。", 404);
        await tx.$queryRaw`SELECT id FROM "MembershipAccount" WHERE id=${input.expectedMemberId} FOR UPDATE`;
        const account = await tx.membershipAccount.findFirst({ where: { id: input.expectedMemberId, programId: program.id, memberNumber: number, active: true } });
        membershipAssert(account, "MEMBERSHIP_NOT_FOUND", "会員情報が変わりました。会員証を読み取り直してください。", 409);
        const existing = await tx.membershipCustomerLink.findFirst({ where: { ...scope(context), OR: [{ customerId: id }, { accountId: account.id, programId: program.id }] } });
        membershipAssert(!existing || existing.customerId === id && existing.accountId === account.id && existing.programId === program.id,
          "MEMBERSHIP_LINK_CONFLICT", "すでに別の会員またはお客様と連携しています。上書きはできません。", 409);
        if (!existing) {
          await tx.membershipCustomerLink.create({ data: { ...scope(context), customerId: id, accountId: account.id, programId: program.id, linkedByUserId: context.user.id } });
          await operationAudit(tx, context, request, { action: "membership.customer.link", resource: "customer", resourceId: id, metadata: { programId: program.id, membershipAccountId: account.id } });
        }
        return receptionDto(tx, context, program.id, account.id, id);
      });
    });

    staff.get("/api/admin/customers/:id/membership", async (request, reply) => {
      const context = await authorize(request, reply, "customer.read"); if (!context) return;
      const { id } = customerParams.parse(request.params); z.object({}).strict().parse(request.query);
      const program = await requireMembershipProgram(database, context.tenant.id);
      await consumeAttempt(database, `staff:${context.user.id}`, program.id, now());
      return serializable(database, async (tx) => {
        await lock(tx, context, "customer.read");
        const currentProgram = await requireMembershipProgram(tx, context.tenant.id);
        membershipAssert(currentProgram.id === program.id, "MEMBERSHIP_UNAVAILABLE", "会員システムの設定が更新されました。読み取り直してください。", 409);
        const customer = await tx.customer.findFirst({ where: { ...scope(context), id }, select: { id: true } });
        membershipAssert(customer, "CUSTOMER_NOT_FOUND", "お客様が見つかりません。", 404);
        const link = await tx.membershipCustomerLink.findFirst({ where: { ...scope(context), customerId: id, programId: program.id } });
        if (!link) return { member: null, linkStatus: "UNLINKED", customerId: id, policy: MEMBERSHIP_POLICY, history: [] };
        return receptionDto(tx, context, program.id, link.accountId, id);
      });
    });
  });

  // This subtree verifies Firebase member credentials independently of staff
  // tenant cookies, membership permissions and barcode contents.
  server.register(async (member) => {
    const identities = new WeakMap<FastifyRequest, MemberIdentity>();
    member.addHook("preHandler", async (request, reply) => {
      reply.header("Cache-Control", "private, no-store").header("Pragma", "no-cache");
      const identity = await authenticate(request, reply); if (identity) identities.set(request, identity);
    });
    member.setErrorHandler((error, _request, reply) => { const safe = membershipSafeError(error); return reply.code(safe.status).send({ code: safe.code, message: safe.message }); });
    member.get("/api/member/membership/programs", async (request) => {
      z.object({}).strict().parse(request.query);
      const identity = identities.get(request)!;
      const publication = publishedMemberTenants();
      const tenantWhere = { status: "ACTIVE" as const, slug: { in: [...publication.keys()] } };
      const select = { id: true, name: true, active: true, tenant: { select: { slug: true, name: true, status: true } },
        accounts: { where: identity, select: { active: true } } } as const;
      const [owned, available] = await Promise.all([
        database.membershipProgram.findMany({ where: { accounts: { some: identity } }, select, orderBy: { name: "asc" }, take: 100 }),
        database.membershipProgram.findMany({ where: { active: true, tenant: { is: tenantWhere } }, select, orderBy: { name: "asc" }, take: 50 }),
      ]);
      const programs = [...new Map([...owned, ...available].map((program) => [program.id, program])).values()];
      return programs.map(({ tenant, accounts, active, ...program }) => {
        const publicTenants = tenant?.status === "ACTIVE" && publication.has(tenant.slug)
          ? [{ slug: tenant.slug, name: tenant.name, brandId: publication.get(tenant.slug)! }] : [];
        return { ...program, pointPolicy: MEMBERSHIP_POLICY, publicTenants, brands: [...new Set(publicTenants.map((tenant) => tenant.brandId))],
          enrolled: accounts.length > 0, canEnroll: active && publicTenants.length > 0 && (!accounts.length || accounts[0].active) };
      });
    });
    member.get("/api/member/membership", async (request) => {
      const { programId } = z.object({ programId: z.string().uuid() }).strict().parse(request.query);
      const identity = identities.get(request)!;
      const own = await database.membershipAccount.findUnique({ where: { programId_projectId_uid: { programId, ...identity } }, select: { id: true } });
      membershipAssert(own, "MEMBERSHIP_NOT_REGISTERED", "この会員プログラムへの登録が必要です。", 404);
      await consumeAttempt(database, `member:${identity.projectId}:${identity.uid}`, programId, now());
      return database.$transaction((tx) => memberDto(tx, identity, programId), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });
    member.post("/api/member/membership", async (request, reply) => {
      const input = membershipEnrollmentSchema.parse(request.body); const identity = identities.get(request)!;
      const tenantWhere = { status: "ACTIVE" as const, slug: { in: [...publishedMemberTenants().keys()] } };
      const program = await database.membershipProgram.findFirst({ where: { id: input.programId, active: true, tenant: { is: tenantWhere } }, select: { id: true } });
      membershipAssert(program, "MEMBERSHIP_UNAVAILABLE", "指定の会員プログラムは現在登録を受け付けていません。", 503);
      await consumeAttempt(database, `member:${identity.projectId}:${identity.uid}`, program.id, now());
      const result = await serializable(database, async (tx) => {
        // Match administrative lock order: tenant before its membership program.
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE "membershipProgramId"=${program.id} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM "MembershipProgram" WHERE id=${program.id} FOR SHARE`;
        const active = await tx.membershipProgram.findFirst({ where: { id: program.id, active: true, tenant: { is: tenantWhere } } });
        membershipAssert(active, "MEMBERSHIP_UNAVAILABLE", "指定の会員プログラムは現在登録を受け付けていません。", 503);
        const existing = await tx.membershipAccount.findUnique({ where: { programId_projectId_uid: { programId: program.id, ...identity } } });
        membershipAssert(!existing || existing.active, "MEMBERSHIP_ACCOUNT_INACTIVE", "この会員情報は利用停止中です。店舗にお問い合わせください。", 409);
        if (!existing) await tx.membershipAccount.create({ data: { programId: program.id, ...identity, displayName: input.displayName } });
        return { created: !existing, value: await memberDto(tx, identity, program.id) };
      });
      return reply.code(result.created ? 201 : 200).send(result.value);
    });
  });
}
