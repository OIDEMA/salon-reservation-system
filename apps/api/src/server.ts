import cors from "@fastify/cors";
import { reservationPrice } from "./reservation-price.js";
import { registerMemberBookingRoutes } from "./member-booking-routes.js";
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
import Fastify, { type FastifyRequest } from "fastify";
import { requirePermission, effectivePermissions, hasPermission } from "./permissions.js";
import { runSerializable, lockOperation, operationAudit, operationError } from "./operations-support.js";
import { assertReservationCapacity, ReservationCapacityError } from "./reservation-capacity.js";
import { legacyPermission } from "./legacy-permissions.js";
import { registerCashRoutes } from "./cash-routes.js";
import { registerChartRoutes } from "./chart-routes.js";
import { registerStaffImportRoutes } from "./staff-import-routes.js";
import { registerHistoryImportRoutes } from "./history-import-routes.js";
import { registerHistoryStaffLinkRoutes } from "./history-staff-links.js";
import { registerHistoryScheduleRoutes } from "./history-schedule.js";
import { registerAccessRoutes } from "./access-routes.js";
import { registerCustomerImportRoutes } from "./customer-import-routes.js";
import { customerExternalDetail } from "./customer-import.js";
import { registerMasterPageRoutes } from "./master-page.js";
import { z } from "zod";
import { prisma } from "./database.js";
import { customerAccountingTotals } from "./accounting-stats.js";
import { customerLookupQuerySchema, lookupCustomers, registeredCustomerPhoneExists } from "./customer-lookup.js";
import { customerPage, customerPageQuerySchema } from "./customer-page.js";
import { reservationPage, reservationPageQuerySchema, reservationOptions, reservationOptionsQuerySchema } from "./reservation-page.js";
import { dashboardQuerySchema, dashboardHistory, dashboardReservationWhere, dashboardScheduleRows, dashboardDisplayHours,
  japanDayBounds, scheduleTime, staffScheduleDependencyCount, type DashboardFilters } from "./dashboard-history.js";
import { requestedSalonId, requireAuthenticatedUser, requireTenantContext, type TenantContext } from "./tenant-context.js";

export const server = Fastify({
  logger: {
    redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: { colorize: true }
          }
  }
});

const createReservationSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  customerId: z.string().optional(),
  requireCustomerSelection: z.boolean().default(false),
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
  closedDays: z.array(z.string().max(4)).max(9).optional(),
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
  return japanDayBounds(date);
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
    historicalReservations: [],
    historicalHasMore: false,
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

async function buildDashboardFromDatabase(date: string, tenantId: string, salonId?: string, filters: DashboardFilters = { status: "ALL" }) {
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

  const scope = { tenantId, salonId: salon.id };
  const [reservations, shifts, history, operationalMetrics] = await Promise.all([
    prisma.reservation.findMany({
      where: dashboardReservationWhere(scope, { start, end }, filters),
      include: {
        customer: true,
        service: true,
        staff: true,
        memberBookingRequest: { select: { price: true } }
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }]
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
    }),
    dashboardHistory(prisma, scope, { start, end }, filters),
    // Metrics remain full-day operational values even when the visual board is searched.
    prisma.reservation.findMany({
      where: { ...scope, startsAt: { gte: start, lt: end } },
      select: { startsAt: true, endsAt: true, status: true, riskScore: true, lineMessageStatus: true,
        service: { select: { price: true } }, memberBookingRequest: { select: { price: true } } }
    })
  ]);

  const rows = dashboardScheduleRows(salon.staff, reservations, shifts, history.historicalReservations);

  const mappedReservations = reservations.map((reservation) => ({
    id: reservation.id,
    rowId: reservation.staffId ?? "unassigned",
    serviceId: reservation.serviceId,
    startTime: scheduleTime(reservation.startsAt, start),
    endTime: scheduleTime(reservation.endsAt, start),
    customerName: reservation.customer.name,
    customerKana: reservation.customer.kana,
    serviceName: reservation.service.name,
    category: reservation.service.category,
    price: reservationPrice(reservation),
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

  const pendingCount = operationalMetrics.filter((reservation) => reservation.status === "PENDING").length;
  const revenue = operationalMetrics.reduce((total, reservation) => total + reservationPrice(reservation), 0);
  const openTime = salon.settings?.openTime ?? "09:00";
  const closeTime = salon.settings?.closeTime ?? "20:00";
  const toMinutes = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };
  const activeStaffCount = salon.staff.filter((staff) => staff.active && staff.role !== "ROOM_RESOURCE").length;
  const bookableMinutes = Math.max(0, toMinutes(closeTime) - toMinutes(openTime)) * activeStaffCount;
  const reservedMinutes = operationalMetrics
    .filter((reservation) => !["CANCELLED", "NO_SHOW"].includes(reservation.status))
    .reduce((total, reservation) => total + Math.max(0, (reservation.endsAt.getTime() - reservation.startsAt.getTime()) / 60_000), 0);
  const messageReservations = operationalMetrics.filter((reservation) => !["NOT_SENT", "QUEUED"].includes(reservation.lineMessageStatus));

  return {
    date,
    salon: {
      id: salon.id,
      name: salon.name,
      timezone: salon.timezone
    },
    hours: dashboardDisplayHours(openTime, closeTime, [...mappedReservations, ...history.historicalReservations]),
    rows,
    reservations: mappedReservations,
    ...history,
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
      confirmedCount: operationalMetrics.filter((reservation) => reservation.status === "CONFIRMED").length,
      occupancyRate: bookableMinutes > 0 ? Math.round((reservedMinutes / bookableMinutes) * 100) : 0,
      waitlistCount: operationalMetrics.filter((reservation) => reservation.status === "WAITLIST").length,
      noShowRiskCount: operationalMetrics.filter((reservation) => reservation.riskScore >= 50).length,
      lineReadRate:
        messageReservations.length > 0
          ? Math.round((messageReservations.filter((reservation) => reservation.lineMessageStatus === "READ").length / messageReservations.length) * 100)
          : 0,
      averageTicket: Math.round(revenue / Math.max(1, operationalMetrics.filter((reservation) => reservationPrice(reservation) > 0).length))
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
      userAgent: request.headers["user-agent"],
      metadata: { salonId: requestedSalonId(request) ?? null }
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

async function recalculateCustomerStats(tenantId: string, salonId: string, customerId: string) {
  await runSerializable(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Salon" WHERE id=${salonId} AND "tenantId"=${tenantId} FOR UPDATE`;
    const completed = await tx.reservation.findMany({
      where: { tenantId, salonId, customerId, status: "COMPLETED" },
      select: { startsAt: true }, orderBy: { startsAt: "desc" }
    });
    const totals = await customerAccountingTotals(tx, tenantId, salonId, [customerId]);
    await tx.customer.updateMany({ where: { id: customerId, tenantId, salonId }, data: {
      visitCount: completed.length, totalSpent: totals.get(customerId) ?? 0,
      lastVisitAt: completed[0]?.startsAt ?? null
    } });
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
  memberBookingRequest?: { price: number } | null;
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
    customer: { id: reservation.customer.id, name: reservation.customer.name, kana: reservation.customer.kana, phone: reservation.customer.phone, visitCount: reservation.customer.visitCount, tags: reservation.customer.tags },
    service: { ...reservation.service, price: reservationPrice(reservation) },
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

const legacyAccess = new WeakMap<FastifyRequest, TenantContext>();
server.addHook("preHandler", async (request, reply) => {
  const route = request.routeOptions.url ?? "";
  if (route.startsWith("/api/member/")) return;
  const permission = legacyPermission(request.method, route);
  if (!permission) return;
  const context = await requirePermission(request, reply, permission);
  if (!context) return;
  legacyAccess.set(request, context);
  if (route.startsWith("/api/admin/customers") && request.body && typeof request.body === "object" && "memo" in request.body && !hasPermission(context, "chart.write")) {
    return reply.code(403).send({ message: "顧客メモを変更するにはカルテの編集権限が必要です。" });
  }
});
server.addHook("preSerialization", async (request, _reply, payload) => {
  const context = legacyAccess.get(request);
  const route = request.routeOptions.url ?? "";
  if (!context || !route.startsWith("/api/admin/customers") || route === "/api/admin/customers/lookup" || !payload || typeof payload !== "object") return payload;
  const sanitize = (customer: Record<string, unknown>) => ({ ...customer,
    ...("memo" in customer && !hasPermission(context, "chart.read") ? { memo: null } : {}),
    ...(!hasPermission(context, "checkout.read") ? { totalSpent: null } : {})
  });
  if (route === "/api/admin/customers/page" && "customers" in payload && Array.isArray(payload.customers)) {
    return { ...payload, customers: payload.customers.map(sanitize) };
  }
  return Array.isArray(payload) ? payload.map(sanitize) : sanitize(payload as Record<string, unknown>);
});

server.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      code: "INVALID_INPUT",
      message: error.issues[0]?.message ?? "入力内容を確認してください。",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError", code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined }, "request failed");
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
  const safeStatusCode = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
  return reply.code(safeStatusCode).send({
    code: error instanceof ReservationCapacityError ? error.code : "REQUEST_FAILED",
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

  const memberships = await prisma.tenantMembership.findMany({
    where: { userId: user.id, status: "ACTIVE", tenant: { status: "ACTIVE" } },
    select: {
      role: true, useCustomPermissions: true, permissions: true, salonIds: true,
      tenant: { select: { id: true, slug: true, name: true,
        salons: { select: { id: true, name: true, timezone: true }, orderBy: { createdAt: "asc" } }
      } }
    },
    orderBy: { createdAt: "asc" }
  });
  return memberships.map((membership) => ({
    role: membership.role,
    permissions: effectivePermissions(membership),
    tenant: { ...membership.tenant,
      salons: membership.tenant.salons.filter((salon) => membership.role === "OWNER" || !membership.salonIds.length || membership.salonIds.includes(salon.id))
    }
  }));
});

server.get("/api/dashboard", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const query = dashboardQuerySchema.parse(request.query);
  reply.header("Cache-Control", "private, no-store");
  return buildDashboardFromDatabase(query.date ?? currentDateInJapan(), context.tenant.id, requestedSalonId(request), query);
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

// Booking screens need the full catalog (including stopped menus for display),
// but they do not need permission to manage master data. Reservation mutations
// still enforce service.active; this endpoint never makes a menu bookable.
server.get("/api/reservation-catalog", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return { menus: [], categories: [], staff: [] };
  const scope = { tenantId: context.tenant.id, salonId: salon.id };
  const [menus, categories, staff] = await Promise.all([
    prisma.service.findMany({ where: scope, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] }),
    prisma.menuCategory.findMany({ where: { ...scope, type: "MENU" }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] }),
    prisma.staff.findMany({ where: { ...scope, active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] })
  ]);
  return reply.header("Cache-Control", "private, no-store").send({ menus, categories, staff });
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
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = settingsInputSchema.parse(request.body);
  const currentSettings = await prisma.salonSettings.findUnique({
    where: { tenantId_salonId: { tenantId: context.tenant.id, salonId: salon.id } }
  });
  if (currentSettings && input.storeId !== undefined && input.storeId !== currentSettings.storeId) {
    return reply.code(409).send({ code: "STORE_ID_IMMUTABLE", message: "店舗IDは作成後に変更できません。" });
  }
  const { salonName, timezone, storeId, ...settings } = input;

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
        storeId: storeId ?? salon.id,
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
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = staffInputSchema.parse(request.body);
  const staff = await prisma.staff.create({ data: { tenantId: context.tenant.id, salonId: salon.id, ...input } });
  await writeAuditLog(request, context, "staff.create", "staff", staff.id);
  return reply.code(201).send(staff);
});

server.patch("/api/admin/staff/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
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
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const dependentCount = await staffScheduleDependencyCount(prisma, { tenantId: context.tenant.id, salonId: salon.id }, id);
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
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = menuInputSchema.parse(request.body);
  const menu = await prisma.service.create({ data: { tenantId: context.tenant.id, salonId: salon.id, ...input } });
  await writeAuditLog(request, context, "menu.create", "service", menu.id);
  return reply.code(201).send(menu);
});

server.patch("/api/admin/menus/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
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
  const context = await requireTenantContext(request, reply);
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
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = categoryInputSchema.parse(request.body);
  const category = await prisma.menuCategory.create({ data: { tenantId: context.tenant.id, salonId: salon.id, ...input } });
  await writeAuditLog(request, context, "category.create", "menuCategory", category.id);
  return reply.code(201).send(category);
});

server.patch("/api/admin/categories/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
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
  const context = await requireTenantContext(request, reply);
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
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = equipmentInputSchema.parse(request.body);
  const equipment = await prisma.equipment.create({ data: { tenantId: context.tenant.id, salonId: salon.id, ...input } });
  await writeAuditLog(request, context, "equipment.create", "equipment", equipment.id);
  return reply.code(201).send(equipment);
});

server.patch("/api/admin/equipment/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
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
  const context = await requireTenantContext(request, reply);
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
  const customers = await prisma.customer.findMany({
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
              ...(hasPermission(context, "chart.read") ? [{ memo: { contains: query.q, mode: "insensitive" as const } }] : []),
              { tags: { has: query.q } }
            ]
          }
        : {})
    },
    include: { _count: { select: { reservations: true } } },
    orderBy: [{ lastVisitAt: "desc" }, { kana: "asc" }],
    take: 500
  });
  const totals = await customerAccountingTotals(prisma, context.tenant.id, salon.id, customers.map((customer) => customer.id));
  return customers.map((customer) => ({ ...customer, totalSpent: totals.get(customer.id) ?? 0 }));
});

server.get("/api/admin/customers/page", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const query = customerPageQuerySchema.parse(request.query);
  const salon = await findScopedSalon(context, request);
  const result = salon
    ? await customerPage(prisma, { tenantId: context.tenant.id, salonId: salon.id,
        readMemo: hasPermission(context, "chart.read"), readCheckout: hasPermission(context, "checkout.read") }, query)
    : { customers: [], total: 0, page: 1, pageSize: query.pageSize, totalPages: 1 };
  return reply.header("Cache-Control", "private, no-store").send(result);
});

server.get("/api/admin/customers/lookup", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const { q } = customerLookupQuerySchema.parse(request.query);
  const salon = await findScopedSalon(context, request);
  const result = salon
    ? await lookupCustomers(prisma, context.tenant.id, salon.id, q)
    : { customers: [], hasMore: false };
  return reply.header("Cache-Control", "private, no-store").send(result);
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
      externalRecords: true,
      reservations: {
        include: { service: true, staff: true, memberBookingRequest: { select: { price: true } } },
        orderBy: { startsAt: "desc" },
        take: 100
      }
    }
  });
  if (!customer) return reply.code(404).send({ code: "CUSTOMER_NOT_FOUND", message: "顧客が見つかりません。" });
  const totals = await customerAccountingTotals(prisma, context.tenant.id, salon.id, [customer.id]);
  return {
    id: customer.id, name: customer.name, kana: customer.kana, phone: customer.phone,
    lineDisplayName: customer.lineDisplayName, tags: customer.tags, visitCount: customer.visitCount,
    totalSpent: totals.get(customer.id) ?? 0, lastVisitAt: customer.lastVisitAt, memo: customer.memo,
    createdAt: customer.createdAt, updatedAt: customer.updatedAt, reservations: customer.reservations.map(({ memberBookingRequest, ...reservation }) => ({ ...reservation, service: { ...reservation.service, price: reservationPrice({ ...reservation, memberBookingRequest }) } })),
    importedProfiles: customer.externalRecords.map((record) => customerExternalDetail(record, hasPermission(context, "chart.read")))
  };
});

server.post("/api/admin/customers", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const input = customerInputSchema.parse(request.body);
  const customer = await runSerializable(async (tx) => {
    await lockOperation(tx, context, "customer.write", salon.id);
    if (input.memo !== undefined && !hasPermission(context, "chart.write")) throw operationError(403, "顧客メモを変更する権限がありません。");
    const created = await tx.customer.create({ data: { tenantId: context.tenant.id, salonId: salon.id, ...input, kana: input.kana || input.name } });
    await operationAudit(tx, context, request, { action: "customer.create", resource: "customer", resourceId: created.id, metadata: { salonId: salon.id } });
    return created;
  });
  return reply.code(201).send(customer);
});

server.patch("/api/admin/customers/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const input = customerInputSchema.partial().parse(request.body);
  return runSerializable(async (tx) => {
    await lockOperation(tx, context, "customer.write", salon.id);
    if (input.memo !== undefined && !hasPermission(context, "chart.write")) throw operationError(403, "顧客メモを変更する権限がありません。");
    const updated = await tx.customer.updateMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id }, data: input });
    if (!updated.count) throw operationError(404, "顧客が見つかりません。");
    await operationAudit(tx, context, request, { action: "customer.update", resource: "customer", resourceId: id, metadata: { salonId: salon.id } });
    return tx.customer.findFirst({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
  });
});

server.delete("/api/admin/customers/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  return runSerializable(async (tx) => {
    await lockOperation(tx, context, "customer.write", salon.id);
    const reservationCount = await tx.reservation.count({ where: { tenantId: context.tenant.id, salonId: salon.id, customerId: id } });
    if (reservationCount) throw operationError(409, "予約履歴がある顧客は削除できません。顧客情報を編集してください。");
    const deleted = await tx.customer.deleteMany({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
    if (!deleted.count) throw operationError(404, "顧客が見つかりません。");
    await operationAudit(tx, context, request, { action: "customer.delete", resource: "customer", resourceId: id, metadata: { salonId: salon.id } });
    return { deleted: true };
  });
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
  const context = await requireTenantContext(request, reply);
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
  const context = await requireTenantContext(request, reply);
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
  const context = await requireTenantContext(request, reply);
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
    include: { customer: true, service: true, staff: true, memberBookingRequest: { select: { price: true } } },
    orderBy: { startsAt: "desc" },
    take: 1000
  });
  return reservations.map(reservationResponse);
});

server.get("/api/reservations/page", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const query = reservationPageQuerySchema.parse(request.query);
  const salon = await findScopedSalon(context, request);
  const result = salon
    ? await reservationPage(prisma, { tenantId: context.tenant.id, salonId: salon.id }, query)
    : { reservations: [], total: 0, page: 1, pageSize: query.pageSize, totalPages: 1 };
  return reply.header("Cache-Control", "private, no-store").send(result);
});

server.get("/api/reservations/options", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const query = reservationOptionsQuerySchema.parse(request.query);
  const salon = await findScopedSalon(context, request);
  const result = salon
    ? await reservationOptions(prisma, { tenantId: context.tenant.id, salonId: salon.id }, query)
    : { reservations: [], hasMore: false };
  return reply.header("Cache-Control", "private, no-store").send(result);
});

server.get("/api/reservations/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await findScopedSalon(context, request);
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const { id } = idParamsSchema.parse(request.params);
  const reservation = await prisma.reservation.findFirst({
    where: { id, tenantId: context.tenant.id, salonId: salon.id },
    include: { customer: true, service: true, staff: true, memberBookingRequest: { select: { price: true } } }
  });
  if (!reservation) return reply.code(404).send({ code: "RESERVATION_NOT_FOUND", message: "予約が見つかりません。" });
  return {
    ...reservationResponse(reservation),
    durationMinutes: Math.round((reservation.endsAt.getTime() - reservation.startsAt.getTime()) / 60_000)
  };
});

server.post("/api/reservations", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const input = createReservationSchema.parse(request.body);
  if (input.paymentStatus !== "UNPAID") return reply.code(409).send({ code: "CHECKOUT_REQUIRED", message: "支払状況は会計画面から記録してください。" });
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return reply.code(409).send({ message: "店舗情報を先に登録してください。" });

  const startsAt = reservationDateTime(input.date, input.startTime);
  const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
  const reservation = await runSerializable(async (transaction) => {
    await lockOperation(transaction, context, "reservation.write", salon.id);
    if (!["CANCELLED", "NO_SHOW"].includes(input.status)) {
      await assertReservationCapacity(transaction, { tenantId: context.tenant.id, salonId: salon.id, startsAt, endsAt, staffId: input.staffId });
    }
    let customer = input.customerId
      ? await transaction.customer.findFirst({ where: { id: input.customerId, tenantId: context.tenant.id, salonId: salon.id } })
      : input.customerPhone
        ? await transaction.customer.findFirst({ where: { tenantId: context.tenant.id, salonId: salon.id, phone: input.customerPhone } })
        : null;
    if (input.customerId && !customer) throw operationError(400, "顧客が見つかりません。");
    if (input.requireCustomerSelection && !input.customerId && (customer || input.customerPhone &&
      await registeredCustomerPhoneExists(transaction, context.tenant.id, salon.id, input.customerPhone))) {
      throw operationError(409, "同じ電話番号の登録済み顧客がいます。検索候補からお客様を選択してください。");
    }
    if (!customer) {
      if (!hasPermission(context, "customer.write")) throw operationError(403, "新規顧客の登録には顧客の編集権限が必要です。登録済みのお客様を選択してください。");
      customer = await transaction.customer.create({ data: {
        tenantId: context.tenant.id, salonId: salon.id, name: input.customerName,
        kana: input.customerKana || input.customerName, phone: input.customerPhone, tags: ["新規"]
      } });
    }
    let service = await transaction.service.findFirst({ where: {
      tenantId: context.tenant.id, salonId: salon.id, active: true,
      ...(input.serviceId ? { id: input.serviceId } : { name: input.serviceName })
    } });
    if (input.serviceId && !service) throw operationError(400, "メニューが見つかりません。");
    if (!service) {
      if (!hasPermission(context, "master.write")) throw operationError(403, "新規メニューの登録にはマスタの編集権限が必要です。登録済みのメニューを選択してください。");
      service = await transaction.service.create({ data: {
        tenantId: context.tenant.id, salonId: salon.id, name: input.serviceName,
        category: "Custom", durationMinutes: input.durationMinutes, price: 0, color: "#0891b2"
      } });
    }

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
      include: { customer: true, service: true, staff: true, memberBookingRequest: { select: { price: true } } }
    });
    await transaction.auditLog.create({
      data: {
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: "reservation.create",
        resource: "reservation",
        resourceId: created.id,
        metadata: { salonId: salon.id },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      }
    });
    return created;
  });

  return reply.code(201).send(reservationResponse(reservation));
});

server.patch("/api/reservations/:id", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
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

  if (input.paymentStatus !== undefined && input.paymentStatus !== existing.paymentStatus) {
    return reply.code(409).send({ code: "CHECKOUT_REQUIRED", message: "支払状況は会計画面から記録してください。" });
  }
  const updated = await runSerializable(async (tx) => {
    await lockOperation(tx, context, "reservation.write", salon.id);
    const current = await tx.reservation.findFirst({ where: { id, tenantId: context.tenant.id, salonId: salon.id } });
    if (!current) throw operationError(404, "予約が見つかりません。");
    if (current.updatedAt.getTime() !== existing.updatedAt.getTime()) throw operationError(409, "予約が更新されています。読み込み直して確認してください。");
    if (input.customerId) {
      const customer = await tx.customer.findFirst({ where: { id: input.customerId, tenantId: context.tenant.id, salonId: salon.id } });
      if (!customer) throw operationError(400, "顧客が見つかりません。");
    }
    if (input.serviceId) {
      const service = await tx.service.findFirst({ where: { id: input.serviceId, tenantId: context.tenant.id, salonId: salon.id, active: true } });
      if (!service) throw operationError(400, "メニューが見つかりません。");
    }
    if (!["CANCELLED", "NO_SHOW"].includes(status)) {
      await assertReservationCapacity(tx, { tenantId: context.tenant.id, salonId: salon.id, startsAt, endsAt, staffId, excludeReservationId: id });
    }
    const changesContext = startsAt.getTime() !== current.startsAt.getTime() || endsAt.getTime() !== current.endsAt.getTime() || staffId !== current.staffId ||
      (input.customerId !== undefined && input.customerId !== current.customerId) || (input.serviceId !== undefined && input.serviceId !== current.serviceId);
    if (changesContext) {
      const [hasCheckout, hasChart] = await Promise.all([
        tx.cashCheckout.count({ where: { tenantId: context.tenant.id, salonId: salon.id, reservationId: id, status: "FINALIZED" } }),
        tx.treatmentChart.count({ where: { tenantId: context.tenant.id, salonId: salon.id, reservationId: id } })
      ]);
      if (hasCheckout || hasChart) throw operationError(409, "会計またはカルテが記録された予約の日時・顧客・メニュー・担当者は変更できません。会計の訂正・カルテの追記から対応してください。");
    }
    const result = await tx.reservation.update({
      where: { tenantId_salonId_id: { tenantId: context.tenant.id, salonId: salon.id, id } },
    data: {
      startsAt,
      endsAt,
      ...(input.customerId ? { customerId: input.customerId } : {}),
      ...(input.serviceId ? { serviceId: input.serviceId } : {}),
      ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.isRequest !== undefined ? { isRequest: input.isRequest } : {})
    },
      include: { customer: true, service: true, staff: true, memberBookingRequest: { select: { price: true } } }
    });
    await operationAudit(tx, context, request, { action: "reservation.update", resource: "reservation", resourceId: id });
    return result;
  });
  await recalculateCustomerStats(context.tenant.id, salon.id, existing.customerId);
  if (updated.customerId !== existing.customerId) await recalculateCustomerStats(context.tenant.id, salon.id, updated.customerId);
  return reservationResponse(updated);
});

server.patch("/api/reservations/:id/status", async (request, reply) => {
  const context = await requireTenantContext(request, reply);
  if (!context) return;
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const params = idParamsSchema.parse(request.params);
  const input = updateStatusSchema.parse(request.body);
  const existing = await prisma.reservation.findFirst({ where: { id: params.id, tenantId: context.tenant.id, salonId: salon.id } });
  if (!existing) return reply.code(404).send({ code: "RESERVATION_NOT_FOUND", message: "予約が見つかりません。" });
  const result = await runSerializable(async (tx) => {
    await lockOperation(tx, context, "reservation.write", salon.id);
    const current = await tx.reservation.findFirst({ where: { id: params.id, tenantId: context.tenant.id, salonId: salon.id } });
    if (!current) throw operationError(404, "予約が見つかりません。");
    if (current.updatedAt.getTime() !== existing.updatedAt.getTime()) throw operationError(409, "予約が更新されています。再読み込みしてから変更してください。");
    if (!["CANCELLED", "NO_SHOW"].includes(input.status)) {
      await assertReservationCapacity(tx, { tenantId: context.tenant.id, salonId: salon.id,
        startsAt: current.startsAt, endsAt: current.endsAt, staffId: current.staffId, excludeReservationId: current.id });
    }
    const updated = await tx.reservation.update({
      where: { tenantId_salonId_id: { tenantId: context.tenant.id, salonId: salon.id, id: params.id } },
      data: { status: input.status }, include: { customer: true, service: true, staff: true, memberBookingRequest: { select: { price: true } } }
    });
    await operationAudit(tx, context, request, { action: "reservation.status.update", resource: "reservation", resourceId: params.id });
    return updated;
  });
  await recalculateCustomerStats(context.tenant.id, salon.id, existing.customerId);
  return reservationResponse(result);
});

registerMemberBookingRoutes(server);
await registerCashRoutes(server);
await registerChartRoutes(server);
await registerStaffImportRoutes(server);
await registerHistoryImportRoutes(server);
await registerHistoryStaffLinkRoutes(server);
await registerHistoryScheduleRoutes(server);
await registerAccessRoutes(server);
await registerCustomerImportRoutes(server);
await registerMasterPageRoutes(server);

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

if (process.env.API_DISABLE_LISTEN !== "1") {
  try {
    await server.listen({ port, host });
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}
