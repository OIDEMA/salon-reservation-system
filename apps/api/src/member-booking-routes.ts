import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { requireMemberIdentity } from "./member-auth.js";
import { capacityReservationStatuses, assertReservationCapacity, ReservationCapacityError } from "./reservation-capacity.js";
import {
  PAYMENT_MODE, MAX_FUTURE_MEMBER_RESERVATIONS, MEMBER_BOOKING_ATTEMPTS_PER_TEN_MINUTES,
  MemberBookingError, memberError, memberCreateSchema, memberAvailabilitySchema, memberPageSchema, idempotencyKeySchema,
  publishedMemberTenants, memberPayloadHash, japanDate, japanTime, japanDateTime, memberBookingWindowDays,
  memberAvailabilitySlots, memberStartIsBookable, memberStaffIsWorking, memberCanCancel,
  type MemberIdentity, type MemberBrand, type MemberCreateInput
} from "./member-booking-domain.js";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Dependencies = { database?: Db; authenticate?: typeof requireMemberIdentity; now?: () => Date; publication?: () => Map<string, MemberBrand> };
const reservationInclude = Prisma.validator<Prisma.ReservationInclude>()({
  salon: { include: { tenant: true, settings: true } }, service: true, staff: true, memberBookingRequest: { select: { price: true } },
  cashCheckouts: { where: { status: "FINALIZED" }, select: { id: true }, take: 1 }, treatmentCharts: { select: { id: true }, take: 1 }
});
type ReservationDtoSource = Prisma.ReservationGetPayload<{ include: typeof reservationInclude }>;
const selectedStaff = { id: true, name: true, active: true, role: true, nominationFee: true, parallelCapacity: true, imageUrl: true } as const;
const memberReservationWhere = (identity: MemberIdentity): Prisma.ReservationWhereInput => ({ customer: { memberLinks: { some: identity } } });

function reservationDto(reservation: ReservationDtoSource, publication: Map<string, MemberBrand>, now: Date) {
  return { id: reservation.id, salonId: reservation.salonId, salonName: reservation.salon.name,
    tenantSlug: reservation.salon.tenant.slug, brandId: publication.get(reservation.salon.tenant.slug),
    serviceId: reservation.serviceId, serviceName: reservation.service.name, category: reservation.service.category,
    staffId: reservation.staffId, staffName: reservation.staff?.name ?? null,
    date: japanDate(reservation.startsAt), startTime: japanTime(reservation.startsAt), endTime: japanTime(reservation.endsAt),
    startsAt: reservation.startsAt.toISOString(), endsAt: reservation.endsAt.toISOString(),
    durationMinutes: Math.round((reservation.endsAt.getTime() - reservation.startsAt.getTime()) / 60_000),
    price: reservation.memberBookingRequest?.price ?? reservation.service.price + (reservation.staff?.nominationFee ?? 0),
    status: reservation.status, paymentStatus: reservation.paymentStatus, paymentMode: PAYMENT_MODE,
    canCancel: !reservation.cashCheckouts.length && !reservation.treatmentCharts.length && memberCanCancel(reservation, reservation.salon.settings, now), createdAt: reservation.createdAt.toISOString(), updatedAt: reservation.updatedAt.toISOString() };
}
async function serializable<T>(database: Db, action: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await database.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 20000 }); }
    catch (error) {
      const retry = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002" ||
        error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)));
      if (!retry || attempt >= 3) throw error;
    }
  }
}
async function lockMemberSalon(tx: Tx, salonId: string, publication: Map<string, MemberBrand>) {
  const initial = await tx.salon.findFirst({ where: { id: salonId, tenant: { slug: { in: [...publication.keys()] }, status: "ACTIVE" } }, select: { tenantId: true } });
  if (!initial) throw memberError(404, "SALON_NOT_FOUND", "店舗が見つかりません。");
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${initial.tenantId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Salon" WHERE id=${salonId} AND "tenantId"=${initial.tenantId} FOR UPDATE`;
  const salon = await tx.salon.findFirst({ where: { id: salonId, tenantId: initial.tenantId, tenant: { slug: { in: [...publication.keys()] }, status: "ACTIVE" } }, include: { settings: true, tenant: true } });
  if (!salon || salon.timezone !== "Asia/Tokyo") throw memberError(404, "SALON_NOT_FOUND", "店舗が見つかりません。");
  return salon;
}
async function publicSalon(database: Db, salonId: string, publication: Map<string, MemberBrand>) {
  const salon = await database.salon.findFirst({ where: { id: salonId, tenant: { slug: { in: [...publication.keys()] }, status: "ACTIVE" }, timezone: "Asia/Tokyo" }, include: { settings: true, tenant: true } });
  if (!salon) throw memberError(404, "SALON_NOT_FOUND", "店舗が見つかりません。");
  return salon;
}
async function publicService(database: Pick<Tx, "service" | "menuCategory">, scope: { tenantId: string; salonId: string }, serviceId: string) {
  const service = await database.service.findFirst({ where: { ...scope, id: serviceId, active: true, lineVisible: true, durationMinutes: { gt: 0, lte: 24 * 60 } } });
  if (!service || await database.menuCategory.findFirst({ where: { ...scope, type: "MENU", name: service.category, enabled: false }, select: { id: true } })) {
    throw memberError(400, "INVALID_SERVICE", "このメニューは現在予約を受け付けていません。");
  }
  return service;
}
async function consumeBookingAttempt(database: Db, identity: MemberIdentity, now: Date) {
  const windowStartsAt = new Date(Math.floor(now.getTime() / 600_000) * 600_000);
  const rate = await database.memberBookingRateLimit.upsert({ where: { projectId_uid_windowStartsAt: { ...identity, windowStartsAt } },
    create: { ...identity, windowStartsAt, attempts: 1 }, update: { attempts: { increment: 1 } } });
  await database.memberBookingRateLimit.deleteMany({ where: { ...identity, windowStartsAt: { lt: new Date(now.getTime() - 86_400_000) } } });
  if (rate.attempts > MEMBER_BOOKING_ATTEMPTS_PER_TEN_MINUTES) throw memberError(429, "BOOKING_RATE_LIMIT", "操作が集中しています。しばらく待ってからお試しください。");
}
async function audit(tx: Tx, request: FastifyRequest, identity: MemberIdentity, tenantId: string, salonId: string, reservationId: string, action: string) {
  await tx.auditLog.create({ data: { tenantId, actorUserId: null, action, resource: "reservation", resourceId: reservationId,
    metadata: { salonId, memberProjectId: identity.projectId, memberUid: identity.uid }, ipAddress: request.ip, userAgent: request.headers["user-agent"] } });
}

export function registerMemberBookingRoutes(server: FastifyInstance, dependencies: Dependencies = {}) {
  const database = dependencies.database ?? prisma; const authenticate = dependencies.authenticate ?? requireMemberIdentity;
  const currentTime = dependencies.now ?? (() => new Date()); const publication = dependencies.publication ?? publishedMemberTenants;
  // Encapsulation keeps the member authentication/error boundary separate from staff routes.
  server.register(async (member) => {
    const identities = new WeakMap<FastifyRequest, MemberIdentity>();
    member.addHook("preHandler", async (request, reply) => {
      reply.header("Cache-Control", "private, no-store").header("Pragma", "no-cache");
      const identity = await authenticate(request, reply); if (identity) identities.set(request, identity);
    });
    member.setErrorHandler((error, request, reply) => {
      if (error instanceof z.ZodError) return reply.code(400).send({ code: "INVALID_INPUT", message: error.issues[0]?.message ?? "入力内容を確認してください。" });
      if (error instanceof MemberBookingError || error instanceof ReservationCapacityError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "member booking request failed");
      return reply.code(500).send({ code: "REQUEST_FAILED", message: "処理中にエラーが発生しました。" });
    });
    const identityFor = (request: FastifyRequest) => identities.get(request)!;
    const allowedReservationWhere = (identity: MemberIdentity, published: Map<string, MemberBrand>): Prisma.ReservationWhereInput => ({
      ...memberReservationWhere(identity), salon: { timezone: "Asia/Tokyo", tenant: { status: "ACTIVE", slug: { in: [...published.keys()] } } }
    });

    member.get("/api/member/catalog", async (request) => {
      z.object({}).strict().parse(request.query);
      const published = publication(); const now = currentTime();
      const salons = await database.salon.findMany({ where: { timezone: "Asia/Tokyo", tenant: { slug: { in: [...published.keys()] }, status: "ACTIVE" } },
        include: { tenant: { select: { slug: true } }, settings: true }, orderBy: [{ tenantId: "asc" }, { createdAt: "asc" }, { id: "asc" }], take: 50 });
      const validSalons = salons.filter((salon) => salon.settings && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(salon.settings.openTime) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(salon.settings.closeTime));
      return { paymentMode: PAYMENT_MODE, salons: await Promise.all(validSalons.map(async (salon) => {
        const scope = { tenantId: salon.tenantId, salonId: salon.id };
        const [categories, blocked, menus, staff] = await Promise.all([
          database.menuCategory.findMany({ where: { ...scope, type: "MENU", enabled: true }, select: { id: true, name: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 500 }),
          database.menuCategory.findMany({ where: { ...scope, type: "MENU", enabled: false }, select: { name: true }, take: 500 }),
          database.service.findMany({ where: { ...scope, active: true, lineVisible: true, durationMinutes: { gt: 0, lte: 24 * 60 } },
            select: { id: true, name: true, category: true, description: true, durationMinutes: true, price: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 500 }),
          database.staff.findMany({ where: { ...scope, active: true, role: { not: "ROOM_RESOURCE" } },
            select: { id: true, name: true, nominationFee: true, imageUrl: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 100 })
        ]);
        const disabled = new Set(blocked.map((category) => category.name));
        return { id: salon.id, tenantSlug: salon.tenant.slug, brandId: published.get(salon.tenant.slug), name: salon.name, timeZone: "Asia/Tokyo",
          acceptingReservations: salon.settings?.acceptingReservations ?? false, bookingWindowDays: salon.settings ? memberBookingWindowDays(salon.settings, now) : 0,
          openTime: salon.settings?.openTime ?? "", closeTime: salon.settings?.closeTime ?? "", candidateIntervalMinutes: salon.settings?.candidateIntervalMinutes ?? 30,
          menus: menus.filter((menu) => !disabled.has(menu.category)), categories, staff };
      })) };
    });

    member.get("/api/member/availability", async (request) => {
      const query = memberAvailabilitySchema.parse(request.query); const now = currentTime(); const published = publication();
      const salon = await publicSalon(database, query.salonId, published); const scope = { tenantId: salon.tenantId, salonId: salon.id };
      const service = await publicService(database, scope, query.serviceId); const start = japanDateTime(query.date); const end = new Date(start.getTime() + 86_400_000);
      const today = japanDateTime(japanDate(now));
      if (start < today || !salon.settings || start.getTime() - today.getTime() > memberBookingWindowDays(salon.settings, now) * 86_400_000) throw memberError(400, "INVALID_DATE", "受付可能期間の日付を選択してください。");
      const staff = await database.staff.findMany({ where: { ...scope, active: true, role: { not: "ROOM_RESOURCE" }, ...(query.staffId ? { id: query.staffId } : {}) }, select: selectedStaff, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 100 });
      if (query.staffId && !staff.length) throw memberError(400, "INVALID_STAFF", "担当スタッフが見つかりません。");
      const [shifts, busy] = await Promise.all([
        database.shift.findMany({ where: { ...scope, startsAt: { lt: end }, endsAt: { gt: start }, OR: [{ staffId: null }, { staffId: { in: staff.map((member) => member.id) } }] }, select: { staffId: true, type: true, startsAt: true, endsAt: true }, take: 5001 }),
        database.reservation.findMany({ where: { ...scope, status: { in: [...capacityReservationStatuses] }, startsAt: { lt: end }, endsAt: { gt: start } }, select: { staffId: true, startsAt: true, endsAt: true }, take: 5001 })
      ]);
      if (shifts.length > 5000 || busy.length > 5000) throw memberError(409, "SLOT_UNAVAILABLE", "空き状況を確認できません。店舗にお問い合わせください。");
      return { salonId: salon.id, serviceId: service.id, date: query.date, timeZone: "Asia/Tokyo", paymentMode: PAYMENT_MODE,
        slots: memberAvailabilitySlots(salon.id, service, salon.settings, staff, shifts, busy, query.date, now) };
    });

    member.get("/api/member/reservations", async (request) => {
      const query = memberPageSchema.parse(request.query); const identity = identityFor(request); const published = publication(); const now = currentTime();
      const where = allowedReservationWhere(identity, published);
      const [total, reservations] = await database.$transaction([
        database.reservation.count({ where }), database.reservation.findMany({ where, include: reservationInclude,
          orderBy: [{ startsAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize })
      ]);
      return { reservations: reservations.map((reservation) => reservationDto(reservation, published, now)), page: query.page, pageSize: query.pageSize, total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)), paymentMode: PAYMENT_MODE };
    });

    member.post("/api/member/reservations", async (request, reply) => {
      const input = memberCreateSchema.parse(request.body); const identity = identityFor(request); const published = publication(); const now = currentTime();
      const key = idempotencyKeySchema.parse(request.headers["idempotency-key"]); const payloadHash = memberPayloadHash(input);
      const replay = await database.memberReservationRequest.findUnique({ where: { projectId_uid_idempotencyKey: { ...identity, idempotencyKey: key } } });
      if (replay) {
        if (replay.payloadHash !== payloadHash) throw memberError(409, "IDEMPOTENCY_CONFLICT", "同じ送信キーで異なる予約は登録できません。");
        const current = await database.reservation.findFirst({ where: { id: replay.reservationId, ...allowedReservationWhere(identity, published) }, include: reservationInclude });
        if (!current) throw memberError(404, "RESERVATION_NOT_FOUND", "予約が見つかりません。");
        return { reservation: reservationDto(current, published, now), paymentMode: PAYMENT_MODE };
      }
      // A separate durable counter also records rejected/conflicting attempts.
      await consumeBookingAttempt(database, identity, now);
      const result = await serializable(database, async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`${identity.projectId}:${identity.uid}`}, 0))`;
        const salon = await lockMemberSalon(tx, input.salonId, published); const scope = { tenantId: salon.tenantId, salonId: salon.id };
        const currentRequest = await tx.memberReservationRequest.findUnique({ where: { projectId_uid_idempotencyKey: { ...identity, idempotencyKey: key } } });
        if (currentRequest) {
          if (currentRequest.payloadHash !== payloadHash) throw memberError(409, "IDEMPOTENCY_CONFLICT", "同じ送信キーで異なる予約は登録できません。");
          const current = await tx.reservation.findFirst({ where: { id: currentRequest.reservationId, ...allowedReservationWhere(identity, published) }, include: reservationInclude });
          if (!current) throw memberError(404, "RESERVATION_NOT_FOUND", "予約が見つかりません。");
          return { reservation: current, created: false };
        }
        const transactionNow = currentTime();
        const settings = salon.settings; const service = await publicService(tx, scope, input.serviceId);
        const staff = await tx.staff.findFirst({ where: { ...scope, id: input.staffId, active: true, role: { not: "ROOM_RESOURCE" } }, select: selectedStaff });
        if (!staff) throw memberError(400, "INVALID_STAFF", "担当スタッフが見つかりません。");
        const price = service.price + staff.nominationFee;
        if (input.expectedPrice !== price) throw memberError(409, "PRICE_CHANGED", "料金が変更されています。空き状況を更新して予約内容をもう一度ご確認ください。");
        if (input.expectedDurationMinutes !== service.durationMinutes) throw memberError(409, "DURATION_CHANGED", "施術時間が変更されています。空き状況を更新して予約内容をもう一度ご確認ください。");
        const startsAt = japanDateTime(input.date, input.startTime); const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
        if (!settings || !memberStartIsBookable(settings, startsAt, service.durationMinutes, transactionNow)) throw memberError(409, "SLOT_UNAVAILABLE", "この日時は現在予約を受け付けていません。");
        const shifts = await tx.shift.findMany({ where: { ...scope, startsAt: { lt: endsAt }, endsAt: { gt: startsAt }, OR: [{ staffId: null }, { staffId: staff.id }] },
          select: { staffId: true, type: true, startsAt: true, endsAt: true }, take: 5001 });
        if (shifts.length > 5000 || !memberStaffIsWorking(staff, shifts, startsAt, endsAt)) throw memberError(409, "SLOT_UNAVAILABLE", "担当スタッフはこの日時に受付できません。");
        await assertReservationCapacity(tx, { ...scope, startsAt, endsAt, staffId: staff.id });
        const futureCount = await tx.reservation.count({ where: { ...memberReservationWhere(identity), startsAt: { gt: transactionNow }, status: { in: ["PENDING", "CONFIRMED", "ARRIVED", "WAITLIST"] } } });
        if (futureCount >= MAX_FUTURE_MEMBER_RESERVATIONS) throw memberError(409, "BOOKING_LIMIT", "予約件数の上限に達しています。既存の予約をご確認ください。");
        let link = await tx.memberCustomerLink.findUnique({ where: { projectId_uid_tenantId_salonId: { ...identity, ...scope } } });
        if (!link) {
          const customer = await tx.customer.create({ data: { ...scope, name: input.customer.name, kana: input.customer.kana, phone: input.customer.phone, tags: ["会員アプリ"] } });
          link = await tx.memberCustomerLink.create({ data: { ...identity, ...scope, customerId: customer.id } });
        } else {
          await tx.customer.update({ where: { tenantId_salonId_id: { ...scope, id: link.customerId } },
            data: { name: input.customer.name, kana: input.customer.kana, phone: input.customer.phone } });
        }
        if (!memberStartIsBookable(settings, startsAt, service.durationMinutes, currentTime())) throw memberError(409, "SLOT_UNAVAILABLE", "受付締切を過ぎました。別の日時を選択してください。");
        const reservation = await tx.reservation.create({ data: { ...scope, customerId: link.customerId, serviceId: service.id, staffId: staff.id, startsAt, endsAt,
          status: "CONFIRMED", source: "MINI_APP", isRequest: true, paymentStatus: "UNPAID", memberBookingRequest: { create: {
            projectId: identity.projectId, uid: identity.uid, idempotencyKey: key, payloadHash, price
          } } }, include: reservationInclude });
        const recipient = settings.notificationEmail?.trim();
        if (settings.notifyReservationEmail && recipient && z.string().email().safeParse(recipient).success) {
          await tx.emailOutbox.create({ data: {
            eventKey: `reservation.created:${reservation.id}`, eventType: "reservation.created",
            ...scope, recipientEmail: recipient,
            payload: { reservationId: reservation.id, salonName: salon.name, startsAt: startsAt.toISOString(),
              serviceName: service.name, tenantSlug: salon.tenant.slug }
          } });
        }
        await audit(tx, request, identity, salon.tenantId, salon.id, reservation.id, "member.reservation.create");
        return { reservation, created: true };
      });
      return reply.code(result.created ? 201 : 200).send({ reservation: reservationDto(result.reservation, published, currentTime()), paymentMode: PAYMENT_MODE });
    });

    member.post("/api/member/reservations/:id/cancel", async (request) => {
      z.object({}).strict().parse(request.body ?? {}); const { id } = z.object({ id: z.string().min(1).max(160) }).parse(request.params);
      const identity = identityFor(request); const published = publication(); const now = currentTime();
      const initial = await database.reservation.findFirst({ where: { id, ...allowedReservationWhere(identity, published) }, select: { salonId: true } });
      if (!initial) throw memberError(404, "RESERVATION_NOT_FOUND", "予約が見つかりません。");
      const result = await serializable(database, async (tx) => {
        const salon = await lockMemberSalon(tx, initial.salonId, published);
        const reservation = await tx.reservation.findFirst({ where: { id, tenantId: salon.tenantId, salonId: salon.id, ...memberReservationWhere(identity) }, include: reservationInclude });
        if (!reservation) throw memberError(404, "RESERVATION_NOT_FOUND", "予約が見つかりません。");
        if (reservation.status === "CANCELLED") return reservation;
        if (!memberCanCancel(reservation, salon.settings, currentTime())) throw memberError(409, "CANCELLATION_UNAVAILABLE", "この予約はアプリからキャンセルできません。店舗にお問い合わせください。");
        const [checkouts, charts] = await Promise.all([
          tx.cashCheckout.count({ where: { tenantId: salon.tenantId, salonId: salon.id, reservationId: id, status: "FINALIZED" } }),
          tx.treatmentChart.count({ where: { tenantId: salon.tenantId, salonId: salon.id, reservationId: id } })
        ]);
        if (checkouts || charts) throw memberError(409, "CANCELLATION_UNAVAILABLE", "施術・会計が記録されている予約は店舗にお問い合わせください。");
        if (!memberCanCancel(reservation, salon.settings, currentTime())) throw memberError(409, "CANCELLATION_UNAVAILABLE", "キャンセル締切を過ぎました。店舗にお問い合わせください。");
        const updated = await tx.reservation.update({ where: { tenantId_salonId_id: { tenantId: salon.tenantId, salonId: salon.id, id } }, data: { status: "CANCELLED" }, include: reservationInclude });
        await audit(tx, request, identity, salon.tenantId, salon.id, id, "member.reservation.cancel");
        return updated;
      });
      return { reservation: reservationDto(result, published, currentTime()), paymentMode: PAYMENT_MODE };
    });
  });
}
