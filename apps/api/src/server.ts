import cors from "@fastify/cors";
import { LineMessageStatus, PaymentStatus, ReservationSource, ReservationStatus, type TenantRole } from "@prisma/client";
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
  lineMessageStatus: z.nativeEnum(LineMessageStatus).default("QUEUED"),
  isRequest: z.boolean().optional(),
  memo: z.string().optional()
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(ReservationStatus)
});

const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  salonName: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(50).default("Asia/Tokyo")
});

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

const corsOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

await server.register(cors, {
  origin: [/^http:\/\/localhost:\d+$/, ...corsOrigins],
  credentials: true
});

server.get("/health", async () => ({
  ok: true,
  service: "reservation-api",
  time: new Date().toISOString()
}));

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

server.post("/api/tenants", async (request, reply) => {
  const user = await requireAuthenticatedUser(request, reply);
  if (!user) return;
  const input = createTenantSchema.parse(request.body);

  const existing = await prisma.tenant.findUnique({ where: { slug: input.slug } });
  if (existing) {
    return reply.code(409).send({ code: "TENANT_SLUG_EXISTS", message: "このテナントIDは既に使用されています。" });
  }

  const result = await prisma.$transaction(async (transaction) => {
    const tenant = await transaction.tenant.create({ data: { name: input.name, slug: input.slug } });
    await transaction.tenantMembership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "OWNER", status: "ACTIVE" }
    });
    const salon = await transaction.salon.create({
      data: { tenantId: tenant.id, name: input.salonName, timezone: input.timezone }
    });
    await transaction.salonSettings.create({
      data: {
        tenantId: tenant.id,
        salonId: salon.id,
        storeId: input.slug,
        cancellationMessage: "",
        friendMessage: ""
      }
    });
    await transaction.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: "tenant.create",
        resource: "tenant",
        resourceId: tenant.id,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      }
    });
    return { tenant, salon };
  });

  return reply.code(201).send(result);
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

server.post("/api/reservations", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const input = createReservationSchema.parse(request.body);
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return reply.code(409).send({ message: "店舗情報を先に登録してください。" });

  if (input.staffId) {
    const staffExists = await prisma.staff.findFirst({
      where: { id: input.staffId, tenantId: context.tenant.id, salonId: salon.id, active: true }
    });
    if (!staffExists) return reply.code(400).send({ code: "INVALID_STAFF", message: "担当スタッフが見つかりません。" });
  }

  const startsAt = new Date(`${input.date}T${input.startTime}:00.000+09:00`);
  const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
  const reservation = await prisma.$transaction(async (transaction) => {
    const customer = await transaction.customer.create({
      data: {
        tenantId: context.tenant.id,
        salonId: salon.id,
        name: input.customerName,
        kana: input.customerKana || input.customerName,
        phone: input.customerPhone,
        tags: ["新規"],
        memo: input.memo
      }
    });
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

server.patch("/api/reservations/:id/status", async (request, reply) => {
  const context = await requireTenantContext(request, reply, writeRoles);
  if (!context) return;
  const salon = await getTenantSalon(context.tenant.id, requestedSalonId(request));
  if (!salon) return reply.code(404).send({ code: "SALON_NOT_FOUND", message: "店舗が見つかりません。" });
  const params = z.object({ id: z.string() }).parse(request.params);
  const input = updateStatusSchema.parse(request.body);

  const result = await prisma.reservation.updateMany({
    where: { id: params.id, tenantId: context.tenant.id, salonId: salon.id },
    data: { status: input.status }
  });
  if (result.count === 0) {
    return reply.code(404).send({ code: "RESERVATION_NOT_FOUND", message: "予約が見つかりません。" });
  }

  await writeAuditLog(request, context, "reservation.status.update", "reservation", params.id);
  return prisma.reservation.findFirst({ where: { id: params.id, tenantId: context.tenant.id, salonId: salon.id } });
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
