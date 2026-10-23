import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./database.js";
import { requireOperationContext, operationAudit, runSerializable, lockOperation } from "./operations-support.js";
import { refreshCustomerAccounting } from "./accounting-stats.js";
import { reservationPrice } from "./reservation-price.js";
import { checkoutPage, checkoutPageQuerySchema } from "./checkout-page.js";
import { registerPage, registerPageQuerySchema, openRegisterOptions } from "./register-page.js";
import { assertCashSettlement, assertCashVersion, businessDateAt, calculateCashDraft, cashAssert,
  cashDraftSchema, CashError, cashRequestHash, expectedCash, CASH_MAX_YEN } from "./cash-domain.js";

type Context = NonNullable<Awaited<ReturnType<typeof requireOperationContext>>>;
type Tx = Prisma.TransactionClient;
const uuid = z.string().uuid();
const identifier = z.string().min(1).max(160);
const amount = z.number().int().min(0).max(CASH_MAX_YEN);
const paramsSchema = z.object({ id: uuid });
const checkoutInclude = { items: { orderBy: { lineNumber: "asc" as const } }, payments: true };
type Checkout = Prisma.CashCheckoutGetPayload<{ include: typeof checkoutInclude }>;
const registerInclude = { movements: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] } };
type Register = Prisma.CashRegisterSessionGetPayload<{ include: typeof registerInclude }>;

function scope(context: Context) { return { tenantId: context.tenant.id, salonId: context.salon.id }; }

async function checkoutFor(tx: Tx, context: Context, id: string) {
  const checkout = await tx.cashCheckout.findFirst({ where: { ...scope(context), id }, include: checkoutInclude });
  cashAssert(checkout, "CHECKOUT_NOT_FOUND", "会計が見つかりません。", 404);
  return checkout;
}

async function registerFor(tx: Tx, context: Context, id: string) {
  const register = await tx.cashRegisterSession.findFirst({ where: { ...scope(context), id }, include: registerInclude });
  cashAssert(register, "REGISTER_NOT_FOUND", "レジが見つかりません。", 404);
  return register;
}

function registerResponse(register: Register) {
  return { ...register, expectedCashYen: register.status === "CLOSED" ? register.expectedCashYen : expectedCash(register.openingCashYen, register.movements) };
}

function draftFrom(checkout: Checkout) {
  return cashDraftSchema.parse({ version: checkout.version,
    items: checkout.items.map(({ label, quantity, unitPriceYen, discountYen, taxRate }) => ({ label, quantity, unitPriceYen, discountYen, taxRate })),
    payments: checkout.payments.map(({ method, amountYen, reference }) => ({ method, amountYen, reference })),
    legacyPaidAcknowledged: checkout.legacyPaidAcknowledged, notes: checkout.notes });
}

async function storeLines(tx: Tx, context: Context, id: string, draft: ReturnType<typeof draftFrom>, totals: ReturnType<typeof calculateCashDraft>) {
  await tx.cashCheckoutItem.deleteMany({ where: { ...scope(context), checkoutId: id } });
  await tx.cashPaymentAllocation.deleteMany({ where: { ...scope(context), checkoutId: id } });
  await tx.cashCheckoutItem.createMany({ data: totals.items.map((item) => ({ ...scope(context), checkoutId: id, ...item })) });
  if (draft.payments.length) await tx.cashPaymentAllocation.createMany({ data: draft.payments.map((payment) => ({ ...scope(context), checkoutId: id, ...payment })) });
}

async function openRegister(tx: Tx, context: Context, id: string | undefined) {
  cashAssert(id, "REGISTER_REQUIRED", "会計の確定・取消には、営業中のレジを指定してください。", 409);
  const register = await registerFor(tx, context, id);
  cashAssert(register.status === "OPEN", "REGISTER_CLOSED", "締め済みのレジには記録できません。", 409);
  cashAssert(register.businessDate === businessDateAt(new Date(), context.salon.timezone),
    "REGISTER_DAY_MISMATCH", "本日の営業レジを指定してください。", 409);
  return register;
}

async function addCheckoutMovement(tx: Tx, context: Context, request: FastifyRequest,
  register: Register, checkout: Checkout, kind: "SALE" | "REFUND", requestId: string) {
  const nextCash = expectedCash(register.openingCashYen, [...register.movements, { kind, amountYen: checkout.cashYen }]);
  cashAssert(nextCash >= 0, "REGISTER_CASH_SHORTAGE", "レジ現金が不足しています。現金の入出金記録を確認してください。", 409);
  await tx.cashRegisterMovement.create({ data: { ...scope(context), sessionId: register.id,
    checkoutId: checkout.id, kind, amountYen: checkout.cashYen,
    reason: kind === "SALE" ? "会計確定" : "会計の全額取消・返金記録",
    requestId, requestHash: cashRequestHash({ checkoutId: checkout.id, sessionId: register.id, kind, amountYen: checkout.cashYen }),
    createdByUserId: context.user.id } });
  await operationAudit(tx, context, request, { action: "register.checkout.record", resource: "cashRegisterSession", resourceId: register.id,
    metadata: { checkoutId: checkout.id, kind, amountYen: checkout.cashYen } });
}

async function cashTransaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
  try { return await runSerializable(operation); } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new CashError("CASH_REQUEST_CONFLICT", "同じ番号が別の操作で使用されています。最新の状態を確認してください。", 409);
    }
    throw error;
  }
}

export function registerCashRoutes(server: FastifyInstance) {
  server.get("/api/cash/checkouts", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.read");
    if (!context) return;
    const query = z.object({ reservationId: identifier.optional() }).strict().parse(request.query);
    return prisma.cashCheckout.findMany({ where: { ...scope(context), ...(query.reservationId ? { reservationId: query.reservationId } : {}) },
      include: checkoutInclude, orderBy: { createdAt: "desc" }, take: 200 });
  });

  server.get("/api/cash/checkouts/page", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.read");
    if (!context) return;
    const query = checkoutPageQuerySchema.parse(request.query);
    return reply.header("Cache-Control", "private, no-store").send(await checkoutPage(prisma, scope(context), query));
  });

  server.get("/api/cash/checkouts/:id", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.read");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const checkout = await prisma.cashCheckout.findFirst({ where: { ...scope(context), id }, include: checkoutInclude });
    if (!checkout) return reply.code(404).send({ code: "CHECKOUT_NOT_FOUND", message: "会計が見つかりません。" });
    return checkout;
  });

  server.post("/api/cash/checkouts", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.write");
    if (!context) return;
    const input = z.object({ reservationId: identifier, requestId: uuid }).strict().parse(request.body);
    const result = await cashTransaction(async (tx) => {
      await lockOperation(tx, context, "checkout.write");
      const retried = await tx.cashCheckout.findFirst({ where: { ...scope(context), createRequestId: input.requestId }, include: checkoutInclude });
      if (retried) {
        cashAssert(retried.reservationId === input.reservationId, "CASH_REQUEST_CONFLICT", "リクエスト番号が別の予約で使用されています。", 409);
        return retried;
      }
      const existing = await tx.cashCheckout.findFirst({ where: { ...scope(context), reservationId: input.reservationId, status: { not: "REVERSED" } }, include: checkoutInclude });
      if (existing) return existing;
      const previous = await tx.cashCheckout.findFirst({ where: { ...scope(context), reservationId: input.reservationId, status: "REVERSED" }, orderBy: { createdAt: "desc" } });
      const reservation = await tx.reservation.findFirst({ where: { ...scope(context), id: input.reservationId }, include: { customer: true, service: true, staff: true, memberBookingRequest: { select: { price: true } } } });
      cashAssert(reservation, "RESERVATION_NOT_FOUND", "予約が見つかりません。", 404);
      cashAssert(!["CANCELLED", "NO_SHOW"].includes(reservation.status), "CASH_RESERVATION_CANCELLED", "取消・無断キャンセルの予約は会計できません。", 409);
      cashAssert(reservation.paymentStatus !== "REFUNDED" || previous, "CASH_RESERVATION_REFUNDED", "返金済み予約には訂正元の会計記録が必要です。", 409);
      const draft = cashDraftSchema.parse({ version: 1, items: [{ label: reservation.service.name, quantity: 1,
        unitPriceYen: reservationPrice(reservation), discountYen: 0, taxRate: 10 }], payments: [], legacyPaidAcknowledged: false, notes: "" });
      const totals = calculateCashDraft(draft);
      const checkout = await tx.cashCheckout.create({ data: { ...scope(context), reservationId: reservation.id,
        createRequestId: input.requestId, createdByUserId: context.user.id, legacyPaymentStatus: reservation.paymentStatus,
        supersedesCheckoutId: previous?.id,
        reservationSnapshot: { customerName: reservation.customer.name, serviceName: reservation.service.name,
          customerId: reservation.customerId, serviceId: reservation.serviceId, staffId: reservation.staffId,
          staffName: reservation.staff?.name ?? "指名なし", salonName: context.salon.name, timezone: context.salon.timezone,
          startsAt: reservation.startsAt.toISOString(), endsAt: reservation.endsAt.toISOString() },
        subtotalYen: totals.subtotalYen, discountYen: totals.discountYen, totalYen: totals.totalYen,
        taxYen: totals.taxYen, taxBreakdown: totals.taxBreakdown, cashYen: 0 } });
      await storeLines(tx, context, checkout.id, draft, totals);
      await operationAudit(tx, context, request, { action: "checkout.create", resource: "cashCheckout", resourceId: checkout.id,
        metadata: { reservationId: reservation.id } });
      return checkoutFor(tx, context, checkout.id);
    });
    return reply.code(201).send(result);
  });

  server.put("/api/cash/checkouts/:id", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.write");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const draft = cashDraftSchema.parse(request.body);
    const totals = calculateCashDraft(draft);
    return cashTransaction(async (tx) => {
      await lockOperation(tx, context, "checkout.write");
      const checkout = await checkoutFor(tx, context, id);
      assertCashVersion(checkout, draft.version, "DRAFT");
      const updated = await tx.cashCheckout.updateMany({ where: { ...scope(context), id, status: "DRAFT", version: draft.version }, data: {
        version: { increment: 1 }, subtotalYen: totals.subtotalYen, discountYen: totals.discountYen,
        totalYen: totals.totalYen, taxYen: totals.taxYen, taxBreakdown: totals.taxBreakdown,
        cashYen: totals.cashYen, legacyPaidAcknowledged: draft.legacyPaidAcknowledged, notes: draft.notes } });
      cashAssert(updated.count === 1, "CASH_VERSION_CONFLICT", "別の操作で更新されました。", 409);
      await storeLines(tx, context, id, draft, totals);
      await operationAudit(tx, context, request, { action: "checkout.draft.update", resource: "cashCheckout", resourceId: id,
        metadata: { totalYen: totals.totalYen, version: draft.version + 1 } });
      return checkoutFor(tx, context, id);
    });
  });

  server.post("/api/cash/checkouts/:id/finalize", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.write");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const input = z.object({ version: z.number().int().positive(), requestId: uuid, registerSessionId: uuid.optional() }).strict().parse(request.body);
    const hash = cashRequestHash({ version: input.version, registerSessionId: input.registerSessionId ?? null });
    return cashTransaction(async (tx) => {
      await lockOperation(tx, context, "checkout.write");
      const checkout = await checkoutFor(tx, context, id);
      if (checkout.finalizeRequestId === input.requestId) {
        cashAssert(checkout.finalizeRequestHash === hash, "CASH_REQUEST_CONFLICT", "同じ確定番号に異なる内容が送信されました。", 409);
        return checkout;
      }
      assertCashVersion(checkout, input.version, "DRAFT");
      await tx.$queryRaw`SELECT id FROM "Reservation" WHERE "tenantId"=${context.tenant.id} AND "salonId"=${context.salon.id} AND id=${checkout.reservationId} FOR UPDATE`;
      const reservation = await tx.reservation.findFirst({ where: { ...scope(context), id: checkout.reservationId } });
      cashAssert(reservation, "RESERVATION_NOT_FOUND", "予約が見つかりません。", 404);
      cashAssert(!["CANCELLED", "NO_SHOW"].includes(reservation.status), "CASH_RESERVATION_CANCELLED", "取消・無断キャンセルの予約は会計を確定できません。", 409);
      const snapshot = checkout.reservationSnapshot as Record<string, unknown>;
      cashAssert(snapshot.customerId === reservation.customerId && snapshot.serviceId === reservation.serviceId &&
        snapshot.staffId === reservation.staffId && snapshot.startsAt === reservation.startsAt.toISOString() && snapshot.endsAt === reservation.endsAt.toISOString(),
        "CASH_RESERVATION_CHANGED", "予約の内容が会計作成後に変更されています。会計の対象を確認してください。", 409);
      const draft = draftFrom(checkout);
      const totals = calculateCashDraft(draft);
      cashAssert(totals.totalYen === checkout.totalYen && totals.cashYen === checkout.cashYen && totals.taxYen === checkout.taxYen,
        "CASH_SNAPSHOT_MISMATCH", "会計明細を再保存してから確定してください。", 409);
      const previous = checkout.supersedesCheckoutId ? await tx.cashCheckout.findFirst({ where: { ...scope(context), id: checkout.supersedesCheckoutId,
        reservationId: checkout.reservationId, status: "REVERSED" } }) : null;
      assertCashSettlement(draft, totals, reservation.paymentStatus, Boolean(previous));
      const register = await openRegister(tx, context, input.registerSessionId);
      await tx.cashCheckout.updateMany({ where: { ...scope(context), id, status: "DRAFT", version: input.version }, data: {
        status: "FINALIZED", version: { increment: 1 }, finalizedAt: new Date(), finalizedByUserId: context.user.id,
        finalizeRequestId: input.requestId, finalizeRequestHash: hash, legacyPaymentStatus: reservation.paymentStatus,
        finalizedSessionId: register.id } });
      if (totals.cashYen > 0) await addCheckoutMovement(tx, context, request, register, checkout, "SALE", input.requestId);
      await tx.cashRegisterSession.updateMany({ where: { ...scope(context), id: register.id, status: "OPEN" }, data: { version: { increment: 1 } } });
      await tx.reservation.updateMany({ where: { ...scope(context), id: checkout.reservationId }, data: { paymentStatus: "PAID" } });
      await refreshCustomerAccounting(tx, context.tenant.id, context.salon.id, reservation.customerId);
      await operationAudit(tx, context, request, { action: "checkout.finalize", resource: "cashCheckout", resourceId: id,
        metadata: { reservationId: checkout.reservationId, totalYen: checkout.totalYen, cashYen: checkout.cashYen, paymentRecordsOnly: true } });
      return checkoutFor(tx, context, id);
    });
  });

  server.post("/api/cash/checkouts/:id/reverse", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.refund");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const input = z.object({ requestId: uuid, reason: z.string().trim().min(1).max(1000),
      refundRecorded: z.literal(true), registerSessionId: uuid.optional() }).strict().parse(request.body);
    const hash = cashRequestHash({ reason: input.reason, refundRecorded: true, registerSessionId: input.registerSessionId ?? null });
    return cashTransaction(async (tx) => {
      await lockOperation(tx, context, "checkout.refund");
      const checkout = await checkoutFor(tx, context, id);
      if (checkout.reverseRequestId === input.requestId) {
        cashAssert(checkout.reverseRequestHash === hash, "CASH_REQUEST_CONFLICT", "同じ取消番号に異なる内容が送信されました。", 409);
        return checkout;
      }
      cashAssert(checkout.status === "FINALIZED", "CASH_NOT_FINALIZED", "確定済みの会計だけ全額取消できます。", 409);
      const register = await openRegister(tx, context, input.registerSessionId);
      await tx.cashCheckout.updateMany({ where: { ...scope(context), id, status: "FINALIZED" }, data: {
        status: "REVERSED", version: { increment: 1 }, reversedAt: new Date(), reversedByUserId: context.user.id,
        reversalReason: input.reason, reverseRequestId: input.requestId, reverseRequestHash: hash, reversedSessionId: register.id } });
      if (checkout.cashYen > 0) await addCheckoutMovement(tx, context, request, register, checkout, "REFUND", input.requestId);
      await tx.cashRegisterSession.updateMany({ where: { ...scope(context), id: register.id, status: "OPEN" }, data: { version: { increment: 1 } } });
      await tx.reservation.updateMany({ where: { ...scope(context), id: checkout.reservationId }, data: { paymentStatus: "REFUNDED" } });
      const reservation = await tx.reservation.findFirst({ where: { ...scope(context), id: checkout.reservationId }, select: { customerId: true } });
      if (reservation) await refreshCustomerAccounting(tx, context.tenant.id, context.salon.id, reservation.customerId);
      await operationAudit(tx, context, request, { action: "checkout.reverse", resource: "cashCheckout", resourceId: id,
        metadata: { totalYen: checkout.totalYen, cashYen: checkout.cashYen, reason: input.reason, refundRecordsOnly: true } });
      return checkoutFor(tx, context, id);
    });
  });

  server.post("/api/cash/checkouts/:id/refresh-reservation", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "checkout.write");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const input = z.object({ version: z.number().int().positive() }).strict().parse(request.body);
    return cashTransaction(async (tx) => {
      await lockOperation(tx, context, "checkout.write");
      const checkout = await checkoutFor(tx, context, id);
      assertCashVersion(checkout, input.version, "DRAFT");
      await tx.$queryRaw`SELECT id FROM "Reservation" WHERE "tenantId"=${context.tenant.id} AND "salonId"=${context.salon.id} AND id=${checkout.reservationId} FOR UPDATE`;
      const reservation = await tx.reservation.findFirst({ where: { ...scope(context), id: checkout.reservationId }, include: { customer: true, service: true, staff: true, memberBookingRequest: { select: { price: true } } } });
      cashAssert(reservation, "RESERVATION_NOT_FOUND", "予約が見つかりません。", 404);
      cashAssert(!["CANCELLED", "NO_SHOW"].includes(reservation.status), "CASH_RESERVATION_CANCELLED", "取消・無断キャンセルの予約は会計できません。", 409);
      const draft = cashDraftSchema.parse({ version: input.version, items: [{ label: reservation.service.name, quantity: 1,
        unitPriceYen: reservationPrice(reservation), discountYen: 0, taxRate: 10 }], payments: [], legacyPaidAcknowledged: false, notes: checkout.notes });
      const totals = calculateCashDraft(draft);
      await tx.cashCheckout.updateMany({ where: { ...scope(context), id, status: "DRAFT", version: input.version }, data: {
        version: { increment: 1 }, legacyPaymentStatus: reservation.paymentStatus, legacyPaidAcknowledged: false,
        subtotalYen: totals.subtotalYen, discountYen: 0, totalYen: totals.totalYen, taxYen: totals.taxYen,
        taxBreakdown: totals.taxBreakdown, cashYen: 0,
        reservationSnapshot: { customerId: reservation.customerId, serviceId: reservation.serviceId, staffId: reservation.staffId,
          customerName: reservation.customer.name, serviceName: reservation.service.name, staffName: reservation.staff?.name ?? "指名なし",
          salonName: context.salon.name, timezone: context.salon.timezone, startsAt: reservation.startsAt.toISOString(), endsAt: reservation.endsAt.toISOString() } } });
      await storeLines(tx, context, id, draft, totals);
      await operationAudit(tx, context, request, { action: "checkout.draft.refresh-reservation", resource: "cashCheckout", resourceId: id,
        metadata: { reservationId: reservation.id, paymentRecordsCleared: true } });
      return checkoutFor(tx, context, id);
    });
  });

  server.get("/api/cash/register-sessions", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "register.read");
    if (!context) return;
    const sessions = await prisma.cashRegisterSession.findMany({ where: scope(context), include: registerInclude, orderBy: { businessDate: "desc" }, take: 90 });
    return sessions.map(registerResponse);
  });

  server.get("/api/cash/register-sessions/page", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "register.read");
    if (!context) return;
    const query = registerPageQuerySchema.parse(request.query);
    return reply.header("Cache-Control", "private, no-store").send(await registerPage(prisma, scope(context), query));
  });

  server.get("/api/cash/register-sessions/options", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "register.read");
    if (!context) return;
    return reply.header("Cache-Control", "private, no-store").send(await openRegisterOptions(prisma, scope(context), businessDateAt(new Date(), context.salon.timezone)));
  });

  server.get("/api/cash/register-sessions/:id", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "register.read");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const session = await prisma.cashRegisterSession.findFirst({ where: { ...scope(context), id }, include: registerInclude });
    if (!session) return reply.code(404).send({ code: "REGISTER_NOT_FOUND", message: "レジが見つかりません。" });
    return registerResponse(session);
  });

  server.post("/api/cash/register-sessions", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "register.close");
    if (!context) return;
    const input = z.object({ businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), openingCashYen: amount, requestId: uuid }).strict().parse(request.body);
    return cashTransaction(async (tx) => {
      await lockOperation(tx, context, "register.close");
      const retried = await tx.cashRegisterSession.findFirst({ where: { ...scope(context), createRequestId: input.requestId }, include: registerInclude });
      if (retried) {
        cashAssert(retried.businessDate === input.businessDate && retried.openingCashYen === input.openingCashYen,
          "CASH_REQUEST_CONFLICT", "同じ開店番号に異なる内容が送信されました。", 409);
        return registerResponse(retried);
      }
      cashAssert(input.businessDate === businessDateAt(new Date(), context.salon.timezone), "REGISTER_DAY_MISMATCH", "開店できるのは本日のレジです。");
      const current = await tx.cashRegisterSession.findFirst({ where: { ...scope(context), OR: [{ businessDate: input.businessDate }, { status: "OPEN" }] } });
      cashAssert(!current, "REGISTER_ALREADY_EXISTS", "本日のレジが既に登録済み、または未締めのレジがあります。", 409);
      const session = await tx.cashRegisterSession.create({ data: { ...scope(context), businessDate: input.businessDate,
        openingCashYen: input.openingCashYen, openedByUserId: context.user.id, createRequestId: input.requestId }, include: registerInclude });
      await operationAudit(tx, context, request, { action: "register.open", resource: "cashRegisterSession", resourceId: session.id,
        metadata: { businessDate: input.businessDate, openingCashYen: input.openingCashYen } });
      return registerResponse(session);
    });
  });

  server.post("/api/cash/register-sessions/:id/movements", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "register.close");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const input = z.object({ version: z.number().int().positive(), requestId: uuid, kind: z.enum(["IN", "OUT"]),
      amountYen: amount.refine((value) => value > 0), reason: z.string().trim().min(1).max(1000) }).strict().parse(request.body);
    const hash = cashRequestHash({ sessionId: id, kind: input.kind, amountYen: input.amountYen, reason: input.reason, version: input.version });
    return cashTransaction(async (tx) => {
      await lockOperation(tx, context, "register.close");
      const register = await registerFor(tx, context, id);
      const retried = await tx.cashRegisterMovement.findFirst({ where: { ...scope(context), requestId: input.requestId } });
      if (retried) {
        cashAssert(retried.requestHash === hash && retried.sessionId === id, "CASH_REQUEST_CONFLICT", "同じ入出金番号に異なる内容が送信されました。", 409);
        return registerResponse(register);
      }
      assertCashVersion(register, input.version, "OPEN");
      cashAssert(expectedCash(register.openingCashYen, [...register.movements, input]) >= 0,
        "REGISTER_CASH_SHORTAGE", "レジ現金を超える出金は記録できません。", 409);
      await tx.cashRegisterMovement.create({ data: { ...scope(context), sessionId: id,
        requestId: input.requestId, requestHash: hash, kind: input.kind, amountYen: input.amountYen,
        reason: input.reason, createdByUserId: context.user.id } });
      await tx.cashRegisterSession.updateMany({ where: { ...scope(context), id, status: "OPEN", version: input.version }, data: { version: { increment: 1 } } });
      await operationAudit(tx, context, request, { action: "register.cash.movement", resource: "cashRegisterSession", resourceId: id,
        metadata: { kind: input.kind, amountYen: input.amountYen, reason: input.reason } });
      return registerResponse(await registerFor(tx, context, id));
    });
  });

  server.post("/api/cash/register-sessions/:id/close", async (request, reply) => {
    const context = await requireOperationContext(request, reply, "register.close");
    if (!context) return;
    const { id } = paramsSchema.parse(request.params);
    const input = z.object({ version: z.number().int().positive(), requestId: uuid,
      countedCashYen: amount, note: z.string().trim().max(2000).default("") }).strict().parse(request.body);
    const hash = cashRequestHash({ version: input.version, countedCashYen: input.countedCashYen, note: input.note });
    return cashTransaction(async (tx) => {
      await lockOperation(tx, context, "register.close");
      const register = await registerFor(tx, context, id);
      if (register.closeRequestId === input.requestId) {
        cashAssert(register.closeRequestHash === hash, "CASH_REQUEST_CONFLICT", "同じ締め番号に異なる内容が送信されました。", 409);
        return registerResponse(register);
      }
      assertCashVersion(register, input.version, "OPEN");
      const expected = expectedCash(register.openingCashYen, register.movements);
      const difference = input.countedCashYen - expected;
      const [sales, reversals] = await Promise.all([
        tx.cashCheckout.findMany({ where: { ...scope(context), finalizedSessionId: id }, include: checkoutInclude, orderBy: { finalizedAt: "asc" } }),
        tx.cashCheckout.findMany({ where: { ...scope(context), reversedSessionId: id }, include: checkoutInclude, orderBy: { reversedAt: "asc" } })
      ]);
      const salesTotalYen = sales.reduce((sum, checkout) => sum + checkout.totalYen, 0);
      const refundsTotalYen = reversals.reduce((sum, checkout) => sum + checkout.totalYen, 0);
      const paymentTotals = ["CASH", "CARD", "BANK", "EXTERNAL_PREPAYMENT", "OTHER"].map((method) => {
        const salesYen = sales.flatMap((checkout) => checkout.payments).filter((payment) => payment.method === method).reduce((sum, payment) => sum + payment.amountYen, 0);
        const refundsYen = reversals.flatMap((checkout) => checkout.payments).filter((payment) => payment.method === method).reduce((sum, payment) => sum + payment.amountYen, 0);
        return { method, salesYen, refundsYen, netYen: salesYen - refundsYen };
      });
      const snapshot = { businessDate: register.businessDate, openingCashYen: register.openingCashYen,
        expectedCashYen: expected, countedCashYen: input.countedCashYen, differenceYen: difference,
        salesCount: sales.length, refundsCount: reversals.length, salesTotalYen, refundsTotalYen,
        netTotalYen: salesTotalYen - refundsTotalYen,
        discountYen: sales.reduce((sum, checkout) => sum + checkout.discountYen, 0),
        taxYen: sales.reduce((sum, checkout) => sum + checkout.taxYen, 0),
        refundsTaxYen: reversals.reduce((sum, checkout) => sum + checkout.taxYen, 0),
        paymentTotals, salesIds: sales.map((checkout) => checkout.id), reversalIds: reversals.map((checkout) => checkout.id),
        movementCount: register.movements.length,
        movements: register.movements.map(({ id: movementId, kind, amountYen, reason, checkoutId, createdAt }) =>
          ({ id: movementId, kind, amountYen, reason, checkoutId, createdAt: createdAt.toISOString() })) };
      await tx.cashRegisterSession.updateMany({ where: { ...scope(context), id, status: "OPEN", version: input.version }, data: {
        status: "CLOSED", version: { increment: 1 }, expectedCashYen: expected, countedCashYen: input.countedCashYen,
        differenceYen: difference, closeSnapshot: snapshot, note: input.note,
        closedAt: new Date(), closedByUserId: context.user.id, closeRequestId: input.requestId, closeRequestHash: hash } });
      await operationAudit(tx, context, request, { action: "register.close", resource: "cashRegisterSession", resourceId: id,
        metadata: { expectedCashYen: expected, countedCashYen: input.countedCashYen, differenceYen: difference } });
      return registerResponse(await registerFor(tx, context, id));
    });
  });
}
