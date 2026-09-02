import cors from "@fastify/cors";
import {
  CategoryType,
  LineMessageStatus,
  PaymentStatus,
  ReservationSource,
  ReservationStatus,
  ShiftType,
  StaffRole,
  type TenantRole
} from "@prisma/client";
import Fastify from "fastify";
import { z } from "zod";
import { prisma } from "./database.js";
import { requestedSalonId, requireAuthenticatedUser, requireTenantContext, type TenantContext } from "./tenant-context.js";

const server = Fastify({
  logger: {
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: { colorize: true }
          }
  }
});

const dateQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const createReservationSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  customerId: z.string().optional(),
  serviceId: z.string().optional(),
  staffId: z.string().optional(),
  customerName: z.string().min(1),
  customerKana: z.string().optional(),
  customerPhone: z.string().optional(),
  serviceName: z.string().min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  durationMinutes: z.number().int().positive().default(60),
  source: z.nativeEnum(ReservationSource).default("LINE"),
  status: z.nativeEnum(ReservationStatus).default("PENDING"),
  paymentStatus: z.nativeEnum(PaymentStatus).default("UNPAID"),
  lineMessageStatus: z.nativeEnum(LineMessageStatus).default("NOT_SENT"),
  isRequest: z.boolean().optional(),
  memo: z.string().optional()
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(ReservationStatus)
});

const idParamsSchema = z.object({ id: z.string().min(1) });

const reservationSearchSchema = z.object({
  q: z.string().trim().optional(),
  status: z.nativeEnum(ReservationStatus).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const updateReservationSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).optional(),
  customerId: z.string().optional(),
  serviceId: z.string().optional(),
  staffId: z.string().nullable().optional(),
  status: z.nativeEnum(ReservationStatus).optional(),
  source: z.nativeEnum(ReservationSource).optional(),
  paymentStatus: z.nativeEnum(PaymentStatus).optional(),
  memo: z.string().max(2000).nullable().optional(),
  isRequest: z.boolean().optional()
});

const customerInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kana: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  lineDisplayName: z.string().trim().max(100).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  memo: z.string().trim().max(4000).nullable().optional()
});

const customerSearchSchema = z.object({
  q: z.string().trim().optional(),
  tag: z.string().trim().optional()
});

const settingsInputSchema = z.object({
  salonName: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  storeId: z.string().trim().min(1).max(80).optional(),
  openTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  closedDays: z.array(z.string().max(4)).max(8).optional(),
  maxConcurrentReservations: z.number().int().min(1).max(100).optional(),
  bookingWindowValue: z.string().max(40).optional(),
  reservationCutoffDays: z.number().int().min(0).max(365).optional(),
  reservationCutoffTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  cancellationCutoffDays: z.number().int().min(0).max(365).optional(),
  cancellationCutoffTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  multiMenuBooking: z.boolean().optional(),
  autoAssignUnspecified: z.boolean().optional(),
  candidateIntervalMinutes: z.number().int().min(5).max(240).optional(),
  questionsEnabled: z.boolean().optional(),
  cancellationMessage: z.string().max(4000).optional(),
  friendMessage: z.string().max(4000).optional(),
  preReservationMessage: z.string().max(4000).optional(),
  acceptingReservations: z.boolean().optional()
});

const staffInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kana: z.string().trim().max(100).default(""),
  role: z.nativeEnum(StaffRole).default("STYLIST"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#18c7bd"),
  imageUrl: z.string().url().nullable().optional(),
  nominationFee: z.number().int().min(0).max(10_000_000).default(0),
  comment: z.string().max(1000).nullable().optional(),
  allocationOrder: z.number().int().min(1).default(1),
  parallelCapacity: z.number().int().min(1).max(20).default(1),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0)
});

const menuInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(100),
  description: z.string().max(4000).default(""),
  durationMinutes: z.number().int().min(5).max(24 * 60),
  price: z.number().int().min(0).max(100_000_000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#18c7bd"),
  menuType: z.string().max(100).default("通常メニュー"),
  lineVisible: z.boolean().default(true),
  unlimitedBooking: z.boolean().default(true),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0)
});

const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.nativeEnum(CategoryType).default("MENU"),
  description: z.string().max(1000).default(""),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0)
});

const equipmentInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  capacity: z.number().int().min(1).max(100).default(1),
  allocationOrder: z.number().int().min(1).default(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#18c7bd"),
  memo: z.string().max(1000).default(""),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0)
});

const shiftFieldsSchema = z.object({
  staffId: z.string().nullable().optional(),
  label: z.string().trim().min(1).max(120),
  type: z.nativeEnum(ShiftType),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date()
});
const shiftInputSchema = shiftFieldsSchema.refine((value) => value.endsAt > value.startsAt, { message: "終了日時は開始日時より後にしてください。" });

const writeRoles: TenantRole[] = ["OWNER", "ADMIN", "MANAGER", "STAFF"];

function dayBounds(date: string) {
  const start = new Date(`${date}T00:00:00.000+09:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start, end };
}

function toTime(date: Date) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo"
  }).format(date);
}

function currentDateInJapan() {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Tokyo"
  }).format(new Date());
}

function buildEmptyDashboard(date: string) {
  return {
    date,
    salon: null,
    hours: {
      start: "09:00",
      end: "20:00",
      stepMinutes: 30
    },
    rows: [],
    reservations: [],
    blocks: [],
    notifications: [],
    queue: [],
    suggestions: [],
    summary: {
      revenue: 0,
      pendingCount: 0,
      confirmedCount: 0,
      occupancyRate: 0,
      waitlistCount: 0,
      noShowRiskCount: 0,
      lineReadRate: 0,
      averageTicket: 0
    }
  };
}

async function buildDashboardFromDatabase(date: string, tenantId: string, salonId?: string) {
  const { start, end } = dayBounds(date);
  const salon = await prisma.salon.findFirst({
    where: {
      tenantId,
      ...(salonId ? { id: salonId } : {})
    },
    include: {
      settings: true,
      staff: { orderBy: { sortOrder: "asc" } },
      notifications: {
        where: { readAt: null },
        orderBy: { createdAt: "desc" },
        take: 6
      }
    }
  });

  if (!salon) {
    return buildEmptyDashboard(date);
  }

  const [reservations, shifts] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        tenantId,
        salonId: salon.id,
        startsAt: { gte: start, lt: end }
      },
      include: {
        customer: true,
        service: true,
        staff: true
      },
      orderBy: { startsAt: "asc" }
    }),
    prisma.shift.findMany({
      where: {
        tenantId,
        salonId: salon.id,
        startsAt: { lt: end },
        endsAt: { gt: start }
      },
      include: { staff: true },
      orderBy: { startsAt: "asc" }
    })
  ]);

  const rows = [
    { id: "unassigned", type: "unassigned", label: "指名なし", subtitle: "自動割当待ち", color: "#334155", count: reservations.filter((reservation) => !reservation.staffId).length },
    ...salon.staff.map((staff) => ({
      id: staff.id,
      type: staff.role === "ROOM_RESOURCE" ? "resource" : "staff",
      label: staff.name,
      subtitle: `${staff.role.toLowerCase()} / 指名 ${reservations.filter((reservation) => reservation.staffId === staff.id && reservation.isRequest).length}`,
      color: staff.color,
      count: reservations.filter((reservation) => reservation.staffId === staff.id).length
    }))
  ];

  const mappedReservations = reservations.map((reservation) => ({
    id: reservation.id,
    rowId: reservation.staffId ?? "unassigned",
    startTime: toTime(reservation.startsAt),
    endTime: toTime(reservation.endsAt),
    customerName: reservation.customer.name,
    customerKana: reservation.customer.kana,
    serviceName: reservation.service.name,
    category: reservation.service.category,
    price: reservation.service.price,
    status: reservation.status,
    source: reservation.source,
    isRequest: reservation.isRequest,
    riskScore: reservation.riskScore,
    lineStatus: reservation.lineMessageStatus,
    paymentStatus: reservation.paymentStatus,
    memo: reservation.memo ?? "",
    visitCount: reservation.customer.visitCount,
    tags: reservation.customer.tags
  }));

  const pendingCount = mappedReservations.filter((reservation) => reservation.status === "PENDING").length;
  const revenue = mappedReservations.reduce((total, reservation) => total + reservation.price, 0);
  const openTime = salon.settings?.openTime ?? "09:00";
  const closeTime = salon.settings?.closeTime ?? "20:00";
  const toMinutes = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };
  const activeStaffCount = salon.staff.filter((staff) => staff.active && staff.role !== "ROOM_RESOURCE").length;
  const bookableMinutes = Math.max(0, toMinutes(closeTime) - toMinutes(openTime)) * activeStaffCount;
  const reservedMinutes = reservations
    .filter((reservation) => !["CANCELLED", "NO_SHOW"].includes(reservation.status))
    .reduce((total, reservation) => total + Math.max(0, (reservation.endsAt.getTime() - reservation.startsAt.getTime()) / 60_000), 0);
  const messageReservations = mappedReservations.filter((reservation) => !["NOT_SENT", "QUEUED"].includes(reservation.lineStatus));

  return {
    date,
    salon: {
      id: salon.id,
      name: salon.name,
      timezone: salon.timezone
    },
    hours: {
      start: openTime,
      end: closeTime,
      stepMinutes: 30
    },
    rows,
    reservations: mappedReservations,
    blocks: shifts.map((shift) => ({
      id: shift.id,
      rowId: shift.staffId ?? "unassigned",
      startTime: toTime(shift.startsAt),
      endTime: toTime(shift.endsAt),
      label: shift.label,
      kind: shift.type
    })),
    notifications: salon.notifications.map((notification) => ({
      id: notification.id,
      severity: notification.severity,
      title: notification.title,
      body: notification.body
    })),
    queue: mappedReservations
      .filter((reservation) => reservation.status === "PENDING")
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 5),
    suggestions: [],
    summary: {
      revenue,
      pendingCount,
      confirmedCount: mappedReservations.filter((reservation) => reservation.status === "CONFIRMED").length,
      occupancyRate: bookableMinutes > 0 ? Math.round((reservedMinutes / bookableMinutes) * 100) : 0,
      waitlistCount: mappedReservations.filter((reservation) => reservation.status === "WAITLIST").length,
      noShowRiskCount: mappedReservations.filter((reservation) => reservation.riskScore >= 50).length,
      lineReadRate:
        messageReservations.length > 0
          ? Math.round((messageReservations.filter((reservation) => reservation.lineStatus === "READ").length / messageReservations.length) * 100)
          : 0,
      averageTicket: Math.round(revenue / Math.max(1, mappedReservations.filter((reservation) => reservation.price > 0).length))
    }
  };
}

async function getTenantSalon(tenantId: string, salonId?: string) {
  return prisma.salon.findFirst({
    where: {
      tenantId,
      ...(salonId ? { id: salonId } : {})
    },
    orderBy: { createdAt: "asc" }
  });
}

async function writeAuditLog(request: Parameters<typeof requestedSalonId>[0], context: TenantContext, action: string, resource: string, resourceId?: string) {
  await prisma.auditLog.create({
    data: {
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action,
      resource,
      resourceId,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    }
  });
}

function reservationDateTime(date: string, time: string) {
  return new Date(`${date}T${time}:00.000+09:00`);
}

function datePartInJapan(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Tokyo"
  }).format(date);
}

async function findScopedSalon(context: TenantContext, request: Parameters<typeof requestedSalonId>[0]) {
  return getTenantSalon(context.tenant.id, requestedSalonId(request));
}

async function ensureReservationSlot(
  reply: Parameters<typeof requireTenantContext>[1],
  tenantId: string,
  salonId: string,
  startsAt: Date,
  endsAt: Date,
  staffId?: string | null,
  excludeReservationId?: string
) {
  const settings = await prisma.salonSettings.findUnique({ where: { tenantId_salonId: { tenantId, salonId } } });
  if (settings && !settings.acceptingReservations) {
    reply.code(409).send({ code: "RESERVATIONS_SUSPENDED", message: "現在、予約受付を停止しています。" });
    return false;
  }

  const activeStatuses: ReservationStatus[] = ["PENDING", "CONFIRMED", "ARRIVED"];
  const overlapWhere = {
    tenantId,
    salonId,
    status: { in: activeStatuses },
    startsAt: { lt: endsAt },
    endsAt: { gt: startsAt },
    ...(excludeReservationId ? { id: { not: excludeReservationId } } : {})
  };
  const [salonOverlapCount, salonUnavailableShift] = await Promise.all([
    prisma.reservation.count({ where: overlapWhere }),
    prisma.shift.findFirst({
      where: {
        tenantId,
        salonId,
        staffId: null,
        type: { in: ["OFF", "BREAK", "SALES_STOP"] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt }
      }
    })
  ]);
  if (salonUnavailableShift) {
    reply.code(409).send({ code: "SALON_UNAVAILABLE", message: "店舗は指定時間に予約を受け付けていません。" });
    return false;
  }
  if (settings && salonOverlapCount >= settings.maxConcurrentReservations) {
    reply.code(409).send({ code: "SALON_CAPACITY_EXCEEDED", message: "店舗の同時受付上限に達しています。" });
    return false;
  }

  if (!staffId) return true;
  const staff = await prisma.staff.findFirst({ where: { id: staffId, tenantId, salonId, active: true } });
  if (!staff) {
    reply.code(400).send({ code: "INVALID_STAFF", message: "担当スタッフが見つかりません。" });
    return false;
  }

  const [staffOverlapCount, unavailableShift] = await Promise.all([
    prisma.reservation.count({ where: { ...overlapWhere, staffId } }),
    prisma.shift.findFirst({
      where: {
        tenantId,
        salonId,
        staffId,
        type: { in: ["OFF", "BREAK", "SALES_STOP"] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt }
      }
    })
  ]);
  if (staffOverlapCount >= staff.parallelCapacity) {
    reply.code(409).send({ code: "STAFF_CONFLICT", message: "担当スタッフの同時間帯の受付上限に達しています。" });
    return false;
  }
  if (unavailableShift) {
    reply.code(409).send({ code: "STAFF_UNAVAILABLE", message: "担当スタッフは指定時間に受付できません。" });
    return false;
  }
  return true;
}

async function recalculateCustomerStats(tenantId: string, salonId: string, customerId: string) {
  const completed = await prisma.reservation.findMany({
    where: { tenantId, salonId, customerId, status: "COMPLETED" },
    select: { startsAt: true, service: { select: { price: true } } },
    orderBy: { startsAt: "desc" }
  });
  await prisma.customer.updateMany({
    where: { id: customerId, tenantId, salonId },
    data: {
      visitCount: completed.length,
      totalSpent: completed.reduce((sum, reservation) => sum + reservation.service.price, 0),
      lastVisitAt: completed[0]?.startsAt ?? null
    }
  });
}

function reservationResponse(reservation: {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: ReservationStatus;
  source: ReservationSource;
  isRequest: boolean;
  memo: string | null;
  riskScore: number;
  paymentStatus: PaymentStatus;
  lineMessageStatus: LineMessageStatus;
  updatedAt: Date;
  customer: { id: string; name: string; kana: string; phone: string | null; visitCount: number; tags: string[] };
  service: { id: string; name: string; category: string; durationMinutes: number; price: number };
  staff: { id: string; name: string } | null;
}) {
  return {
    id: reservation.id,
    date: datePartInJapan(reservation.startsAt),
    startTime: toTime(reservation.startsAt),
    endTime: toTime(reservation.endsAt),
    status: reservation.status,
    source: reservation.source,
    isRequest: reservation.isRequest,
    memo: reservation.memo ?? "",
    riskScore: reservation.riskScore,
    paymentStatus: reservation.paymentStatus,
    lineMessageStatus: reservation.lineMessageStatus,
    updatedAt: reservation.updatedAt.toISOString(),
    customer: reservation.customer,
    service: reservation.service,
    staff: reservation.staff
  };
}

const corsOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

await server.register(cors, {
  origin: [/^http:\/\/localhost:\d+$/, ...corsOrigins],
  credentials: true
});

server.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      code: "INVALID_INPUT",
      message: error.issues[0]?.message ?? "入力内容を確認してください。",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  request.log.error({ error }, "request failed");
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
  const safeStatusCode = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
  return reply.code(safeStatusCode).send({
    code: "REQUEST_FAILED",
    message: safeStatusCode < 500 && error instanceof Error ? error.message : "処理中にエラーが発生しました。"
  });
});

server.get("/health", async () => ({
  ok: true,
  service: "reservation-api",
  time: new Date().toISOString()
}));

server.get("/ready", async (request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, service: "reservation-api", database: "ready", time: new Date().toISOString() };
  } catch (error) {
    request.log.error({ error }, "database readiness check failed");
    return reply.code(503).send({ ok: false, service: "reservation-api", database: "unavailable" });
  }
});

server.get("/api/me/tenants", async (request, reply) => {
  const user = await requireAuthenticatedUser(request, reply);
  if (!user) return;

  return prisma.tenantMembership.findMany({
    where: { userId: user.id, status: "ACTIVE", tenant: { status: "ACTIVE" } },
    select: {
      role: true,
      tenant: {
        select: {
          id: true,
          slug: true,
          name: true,
          salons: {
            select: { id: true, name: true, timezone: true },
            orderBy: { createdAt: "asc" }
          }
        }
      }
    },
    orderBy: { createdAt: "asc" }
  });
});

server.get("/api/dashboard", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const query = dateQuerySchema.parse(request.query);
  return buildDashboardFromDatabase(query.date ?? currentDateInJapan(), context.tenant.id, requestedSalonId(request));
});

server.get("/api/staff", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return [];
  return prisma.staff.findMany({
    where: { tenantId: context.tenant.id, salonId: salon.id, active: true },
    orderBy: { sortOrder: "asc" }
  });
});

server.get("/api/services", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return [];
  return prisma.service.findMany({
    where: { tenantId: context.tenant.id, salonId: salon.id, active: true },
    orderBy: [{ category: "asc" }, { name: "asc" }]
  });
});

server.get("/api/admin/settings", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await prisma.salon.findFirst({
    where: {
      tenantId: context.tenant.id,
      ...(requestedSalonId(request) ? { id: requestedSalonId(request) } : {})
    },
    orderBy: { createdAt: "asc" },
    include: { settings: true }
  });

  if (!salon) return { salon: null, settings: null };
  return {
    salon: { id: salon.id, name: salon.name, timezone: salon.timezone },
    settings: salon.settings
  };
});

server.get("/api/admin/staff", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return [];
  return prisma.staff.findMany({ where: { tenantId: context.tenant.id, salonId: salon.id }, orderBy: { sortOrder: "asc" } });
});

server.get("/api/admin/menus", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return [];
  return prisma.service.findMany({ where: { tenantId: context.tenant.id, salonId: salon.id }, orderBy: { sortOrder: "asc" } });
});

server.get("/api/admin/categories", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return [];
  return prisma.menuCategory.findMany({ where: { tenantId: context.tenant.id, salonId: salon.id }, orderBy: { sortOrder: "asc" } });
});

server.get("/api/admin/equipment", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return [];
  return prisma.equipment.findMany({ where: { tenantId: context.tenant.id, salonId: salon.id }, orderBy: { sortOrder: "asc" } });
});

server.patch("/api/admin/settings", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = settingsInputSchema.parse(request.body);
  const { salonName, timezone, ...settings } = input;

  const result = await prisma.$transaction(async (transaction) => {
    const updatedSalon = await transaction.salon.update({
      where: { id: salon.id },
      data: { ...(salonName ? { name: salonName } : {}), ...(timezone ? { timezone } : {}) }
    });
    const updatedSettings = await transaction.salonSettings.upsert({
      where: { tenantId_salonId: { tenantId: context.tenant.id, salonId: salon.id } },
      update: settings,
      create: {
        tenantId: context.tenant.id,
        salonId: salon.id,
        storeId: settings.storeId ?? salon.id,
        cancellationMessage: settings.cancellationMessage ?? "キャンセルを受け付けました。",
        friendMessage: settings.friendMessage ?? "ご登録ありがとうございます。",
        ...settings
      }
    });
    return { salon: updatedSalon, settings: updatedSettings };
  });
  await writeAuditLog(request, context, "settings.update", "salonSettings", result.settings.id);
  return result;
});

server.post("/api/admin/staff", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = staffInputSchema.parse(request.body);
  const staff = await prisma.staff.create({ data: { tenantId: context.tenant.id, salonId: salon.id, ...input } });
  await writeAuditLog(request, context, "staff.create", "staff", staff.id);
  return reply.code(201).send(staff);
});

server.patch("/api/admin/staff/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const input = staffInputSchema.partial().parse(request.body);
  const updated = await prisma.staff.updateMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id }, data: input });
  if (!updated.count) return reply.code(404).send({ code: "STAFF_NOT_FOUND", message: "スタッフが見つかりません。" });
  await writeAuditLog(request, context, "staff.update", "staff", id);
  return prisma.staff.findFirst({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
});

server.delete("/api/admin/staff/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const [reservationCount, shiftCount] = await Promise.all([
    prisma.reservation.count({ where: { tenantId: context.tenant.id, salonId: salon.id, staffId: id } }),
    prisma.shift.count({ where: { tenantId: context.tenant.id, salonId: salon.id, staffId: id } })
  ]);
  const dependentCount = reservationCount + shiftCount;
  if (dependentCount) {
    const updated = await prisma.staff.updateMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id }, data: { active: false } });
    if (!updated.count) return reply.code(404).send({ code: "STAFF_NOT_FOUND", message: "スタッフが見つかりません。" });
    await writeAuditLog(request, context, "staff.deactivate", "staff", id);
    return { deleted: false, deactivated: true };
  }
  const deleted = await prisma.staff.deleteMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
  if (!deleted.count) return reply.code(404).send({ code: "STAFF_NOT_FOUND", message: "スタッフが見つかりません。" });
  await writeAuditLog(request, context, "staff.delete", "staff", id);
  return { deleted: true, deactivated: false };
});

server.post("/api/admin/menus", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = menuInputSchema.parse(request.body);
  const menu = await prisma.service.create({ data: { tenantId: context.tenant.id, salonId: salon.id, ...input } });
  await writeAuditLog(request, context, "menu.create", "service", menu.id);
  return reply.code(201).send(menu);
});

server.patch("/api/admin/menus/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const input = menuInputSchema.partial().parse(request.body);
  const updated = await prisma.service.updateMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id }, data: input });
  if (!updated.count) return reply.code(404).send({ code: "MENU_NOT_FOUND", message: "メニューが見つかりません。" });
  await writeAuditLog(request, context, "menu.update", "service", id);
  return prisma.service.findFirst({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
});

server.delete("/api/admin/menus/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const dependentCount = await prisma.reservation.count({ where: { tenantId: context.tenant.id, salonId: salon.id, serviceId: id } });
  if (dependentCount) {
    const updated = await prisma.service.updateMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id }, data: { active: false } });
    if (!updated.count) return reply.code(404).send({ code: "MENU_NOT_FOUND", message: "メニューが見つかりません。" });
    await writeAuditLog(request, context, "menu.deactivate", "service", id);
    return { deleted: false, deactivated: true };
  }
  const deleted = await prisma.service.deleteMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
  if (!deleted.count) return reply.code(404).send({ code: "MENU_NOT_FOUND", message: "メニューが見つかりません。" });
  await writeAuditLog(request, context, "menu.delete", "service", id);
  return { deleted: true, deactivated: false };
});

server.post("/api/admin/categories", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = categoryInputSchema.parse(request.body);
  const category = await prisma.menuCategory.create({ data: { tenantId: context.tenant.id, salonId: salon.id, ...input } });
  await writeAuditLog(request, context, "category.create", "menuCategory", category.id);
  return reply.code(201).send(category);
});

server.patch("/api/admin/categories/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const input = categoryInputSchema.partial().parse(request.body);
  const updated = await prisma.menuCategory.updateMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id }, data: input });
  if (!updated.count) return reply.code(404).send({ code: "CATEGORY_NOT_FOUND", message: "カテゴリーが見つかりません。" });
  await writeAuditLog(request, context, "category.update", "menuCategory", id);
  return prisma.menuCategory.findFirst({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
});

server.delete("/api/admin/categories/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const deleted = await prisma.menuCategory.deleteMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
  if (!deleted.count) return reply.code(404).send({ code: "CATEGORY_NOT_FOUND", message: "カテゴリーが見つかりません。" });
  await writeAuditLog(request, context, "category.delete", "menuCategory", id);
  return { deleted: true };
});

server.post("/api/admin/equipment", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = equipmentInputSchema.parse(request.body);
  const equipment = await prisma.equipment.create({ data: { tenantId: context.tenant.id, salonId: salon.id, ...input } });
  await writeAuditLog(request, context, "equipment.create", "equipment", equipment.id);
  return reply.code(201).send(equipment);
});

server.patch("/api/admin/equipment/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const input = equipmentInputSchema.partial().parse(request.body);
  const updated = await prisma.equipment.updateMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id }, data: input });
  if (!updated.count) return reply.code(404).send({ code: "EQUIPMENT_NOT_FOUND", message: "設備が見つかりません。" });
  await writeAuditLog(request, context, "equipment.update", "equipment", id);
  return prisma.equipment.findFirst({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
});

server.delete("/api/admin/equipment/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const deleted = await prisma.equipment.deleteMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
  if (!deleted.count) return reply.code(404).send({ code: "EQUIPMENT_NOT_FOUND", message: "設備が見つかりません。" });
  await writeAuditLog(request, context, "equipment.delete", "equipment", id);
  return { deleted: true };
});

server.get("/api/admin/customers", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return [];
  const query = customerSearchSchema.parse(request.query);
  return prisma.customer.findMany({
    where: {
      tenantId: context.tenant.id,
      salonId: salon.id,
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { kana: { contains: query.q, mode: "insensitive" } },
              { phone: { contains: query.q, mode: "insensitive" } },
              { lineDisplayName: { contains: query.q, mode: "insensitive" } },
              { memo: { contains: query.q, mode: "insensitive" } },
              { tags: { has: query.q } }
            ]
          }
        : {})
    },
    include: { _count: { select: { reservations: true } } },
    orderBy: [{ lastVisitAt: "desc" }, { kana: "asc" }],
    take: 500
  });
});

server.get("/api/admin/customers/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const customer = await prisma.customer.findFirst({
    where: { id, tenantId: context.tenant.id, salonId: salon.id },
    include: {
      reservations: {
        include: { service: true, staff: true },
        orderBy: { startsAt: "desc" },
        take: 100
      }
    }
  });
  if (!customer) return reply.code(404).send({ code: "CUSTOMER_NOT_FOUND", message: "顧客が見つかりません。" });
  return customer;
});

server.post("/api/admin/customers", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = customerInputSchema.parse(request.body);
  const customer = await prisma.customer.create({
    data: {
      tenantId: context.tenant.id,
      salonId: salon.id,
      ...input,
      kana: input.kana || input.name
    }
  });
  await writeAuditLog(request, context, "customer.create", "customer", customer.id);
  return reply.code(201).send(customer);
});

server.patch("/api/admin/customers/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const input = customerInputSchema.partial().parse(request.body);
  const updated = await prisma.customer.updateMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id }, data: input });
  if (!updated.count) return reply.code(404).send({ code: "CUSTOMER_NOT_FOUND", message: "顧客が見つかりません。" });
  await writeAuditLog(request, context, "customer.update", "customer", id);
  return prisma.customer.findFirst({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
});

server.delete("/api/admin/customers/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const reservationCount = await prisma.reservation.count({ where: { tenantId: context.tenant.id, salonId: salon.id, customerId: id } });
  if (reservationCount) {
    return reply.code(409).send({ code: "CUSTOMER_HAS_HISTORY", message: "予約履歴がある顧客は削除できません。顧客情報を編集してください。" });
  }
  const deleted = await prisma.customer.deleteMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
  if (!deleted.count) return reply.code(404).send({ code: "CUSTOMER_NOT_FOUND", message: "顧客が見つかりません。" });
  await writeAuditLog(request, context, "customer.delete", "customer", id);
  return { deleted: true };
});

server.get("/api/admin/shifts", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return [];
  const query = reservationSearchSchema.pick({ dateFrom: true, dateTo: true }).parse(request.query);
  return prisma.shift.findMany({
    where: {
      tenantId: context.tenant.id,
      salonId: salon.id,
      ...(query.dateFrom ? { endsAt: { gt: dayBounds(query.dateFrom).start } } : {}),
      ...(query.dateTo ? { startsAt: { lt: dayBounds(query.dateTo).end } } : {})
    },
    include: { staff: true },
    orderBy: { startsAt: "asc" }
  });
});

server.post("/api/admin/shifts", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = shiftInputSchema.parse(request.body);
  if (input.staffId) {
    const staff = await prisma.staff.findFirst({ where: { id: input.staffId, tenantId: context.tenant.id, salonId: salon.id } });
    if (!staff) return reply.code(400).send({ code: "INVALID_STAFF", message: "スタッフが見つかりません。" });
  }
  const shift = await prisma.shift.create({ data: { tenantId: context.tenant.id, salonId: salon.id, ...input } });
  await writeAuditLog(request, context, "shift.create", "shift", shift.id);
  return reply.code(201).send(shift);
});

server.patch("/api/admin/shifts/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const input = shiftFieldsSchema.partial().parse(request.body);
  const existing = await prisma.shift.findFirst({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
  if (!existing) return reply.code(404).send({ code: "SHIFT_NOT_FOUND", message: "シフトが見つかりません。" });
  if ((input.endsAt ?? existing.endsAt) <= (input.startsAt ?? existing.startsAt)) {
    return reply.code(400).send({ code: "INVALID_SHIFT_RANGE", message: "終了日時は開始日時より後にしてください。" });
  }
  const updated = await prisma.shift.updateMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id }, data: input });
  if (!updated.count) return reply.code(404).send({ code: "SHIFT_NOT_FOUND", message: "シフトが見つかりません。" });
  await writeAuditLog(request, context, "shift.update", "shift", id);
  return prisma.shift.findFirst({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
});

server.delete("/api/admin/shifts/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const deleted = await prisma.shift.deleteMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
  if (!deleted.count) return reply.code(404).send({ code: "SHIFT_NOT_FOUND", message: "シフトが見つかりません。" });
  await writeAuditLog(request, context, "shift.delete", "shift", id);
  return { deleted: true };
});

server.get("/api/reservations", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return [];
  const query = reservationSearchSchema.parse(request.query);
  const dateFrom = query.dateFrom ? dayBounds(query.dateFrom).start : undefined;
  const dateTo = query.dateTo ? dayBounds(query.dateTo).end : undefined;
  const reservations = await prisma.reservation.findMany({
    where: {
      tenantId: context.tenant.id,
      salonId: salon.id,
      ...(query.status ? { status: query.status } : {}),
      ...(dateFrom || dateTo ? { startsAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lt: dateTo } : {}) } } : {}),
      ...(query.q
        ? {
            OR: [
              { customer: { name: { contains: query.q, mode: "insensitive" } } },
              { customer: { kana: { contains: query.q, mode: "insensitive" } } },
              { customer: { phone: { contains: query.q, mode: "insensitive" } } },
              { service: { name: { contains: query.q, mode: "insensitive" } } },
              { memo: { contains: query.q, mode: "insensitive" } }
            ]
          }
        : {})
    },
    include: { customer: true, service: true, staff: true },
    orderBy: { startsAt: "desc" },
    take: 1000
  });
  return reservations.map(reservationResponse);
});

server.post("/api/reservations", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const input = createReservationSchema.parse(request.body);
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return reply.code(409).send({ message: "店舗情報を先に登録してください。" });

  const startsAt = reservationDateTime(input.date, input.startTime);
  const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
  if (!["CANCELLED", "NO_SHOW"].includes(input.status)) {
    const slotAvailable = await ensureReservationSlot(reply, context.tenant.id, salon.id, startsAt, endsAt, input.staffId);
    if (!slotAvailable) return;
  }
  const reservation = await prisma.$transaction(async (transaction) => {
    const customer =
      (input.customerId
        ? await transaction.customer.findFirst({
            where: { id: input.customerId, tenantId: context.tenant.id, salonId: salon.id }
          })
        : null) ??
      (input.customerPhone
        ? await transaction.customer.findFirst({
            where: { tenantId: context.tenant.id, salonId: salon.id, phone: input.customerPhone }
          })
        : null) ??
      (await transaction.customer.create({
        data: {
          tenantId: context.tenant.id,
          salonId: salon.id,
          name: input.customerName,
          kana: input.customerKana || input.customerName,
          phone: input.customerPhone,
          tags: ["新規"],
          memo: input.memo
        }
      }));
    const service =
      (input.serviceId
        ? await transaction.service.findFirst({
            where: { id: input.serviceId, tenantId: context.tenant.id, salonId: salon.id, active: true }
          })
        : null) ??
      (await transaction.service.findFirst({
        where: { tenantId: context.tenant.id, salonId: salon.id, name: input.serviceName }
      })) ??
      (await transaction.service.create({
        data: {
          tenantId: context.tenant.id,
          salonId: salon.id,
          name: input.serviceName,
          category: "Custom",
          durationMinutes: input.durationMinutes,
          price: 0,
          color: "#0891b2"
        }
      }));

    const created = await transaction.reservation.create({
      data: {
        tenantId: context.tenant.id,
        salonId: salon.id,
        staffId: input.staffId,
        customerId: customer.id,
        serviceId: service.id,
        startsAt,
        endsAt,
        status: input.status,
        source: input.source,
        isRequest: input.isRequest ?? Boolean(input.staffId),
        memo: input.memo,
        paymentStatus: input.paymentStatus,
        lineMessageStatus: input.lineMessageStatus
      },
      include: { customer: true, service: true, staff: true }
    });
    await transaction.auditLog.create({
      data: {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "reservation.create",
        resource: "reservation",
        resourceId: created.id,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      }
    });
    return created;
  });

  return reply.code(201).send(reservation);
});

server.patch("/api/reservations/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const input = updateReservationSchema.parse(request.body);
  const existing = await prisma.reservation.findFirst({
    where: { id, tenantId: context.tenant.id, salonId: salon.id },
    include: { service: true }
  });
  if (!existing) return reply.code(404).send({ code: "RESERVATION_NOT_FOUND", message: "予約が見つかりません。" });

  const date = input.date ?? datePartInJapan(existing.startsAt);
  const startTime = input.startTime ?? toTime(existing.startsAt);
  const startsAt = reservationDateTime(date, startTime);
  const durationMinutes = input.durationMinutes ?? Math.round((existing.endsAt.getTime() - existing.startsAt.getTime()) / 60_000);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
  const staffId = input.staffId === undefined ? existing.staffId : input.staffId;
  const status = input.status ?? existing.status;

  if (input.customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: input.customerId, tenantId: context.tenant.id, salonId: salon.id } });
    if (!customer) return reply.code(400).send({ code: "INVALID_CUSTOMER", message: "顧客が見つかりません。" });
  }
  if (input.serviceId) {
    const service = await prisma.service.findFirst({ where: { id: input.serviceId, tenantId: context.tenant.id, salonId: salon.id, active: true } });
    if (!service) return reply.code(400).send({ code: "INVALID_SERVICE", message: "メニューが見つかりません。" });
  }
  if (!["CANCELLED", "NO_SHOW"].includes(status)) {
    const slotAvailable = await ensureReservationSlot(reply, context.tenant.id, salon.id, startsAt, endsAt, staffId, id);
    if (!slotAvailable) return;
  }

  const updated = await prisma.reservation.update({
    where: { id },
    data: {
      startsAt,
      endsAt,
      ...(input.customerId ? { customerId: input.customerId } : {}),
      ...(input.serviceId ? { serviceId: input.serviceId } : {}),
      ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.paymentStatus ? { paymentStatus: input.paymentStatus } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.isRequest !== undefined ? { isRequest: input.isRequest } : {})
    },
    include: { customer: true, service: true, staff: true }
  });
  await Promise.all([
    recalculateCustomerStats(context.tenant.id, salon.id, existing.customerId),
    ...(updated.customerId !== existing.customerId ? [recalculateCustomerStats(context.tenant.id, salon.id, updated.customerId)] : []),
    writeAuditLog(request, context, "reservation.update", "reservation", id)
  ]);
  return reservationResponse(updated);
});

server.patch("/api/reservations/:id/status", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const params = idParamsSchema.parse(request.params);
  const input = updateStatusSchema.parse(request.body);
  const existing = await prisma.reservation.findFirst({ where: { id: params.id, tenantId: context.tenant.id, salonId: salon.id } });
  if (!existing) return reply.code(404).send({ code: "RESERVATION_NOT_FOUND", message: "予約が見つかりません。" });
  if (!["CANCELLED", "NO_SHOW"].includes(input.status)) {
    const slotAvailable = await ensureReservationSlot(
      reply,
      context.tenant.id,
      salon.id,
      existing.startsAt,
      existing.endsAt,
      existing.staffId,
      existing.id
    );
    if (!slotAvailable) return;
  }
  const result = await prisma.reservation.update({
    where: { id: params.id },
    data: { status: input.status },
    include: { customer: true, service: true, staff: true }
  });
  await recalculateCustomerStats(context.tenant.id, salon.id, existing.customerId);
  await writeAuditLog(request, context, "reservation.status.update", "reservation", params.id);
  return reservationResponse(result);
});

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4001);
const host = process.env.API_HOST ?? "0.0.0.0";

async function shutdown(signal: string) {
  server.log.info({ signal }, "shutting down");
  await server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await server.listen({ port, host });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
