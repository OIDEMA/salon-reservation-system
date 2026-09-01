import cors from "@fastify/cors";
import { LineMessageStatus, PaymentStatus, PrismaClient, ReservationSource, ReservationStatus } from "@prisma/client";
import Fastify from "fastify";
import { z } from "zod";

const prisma = new PrismaClient();
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

async function buildDashboardFromDatabase(date: string) {
  const { start, end } = dayBounds(date);
  const salon = await prisma.salon.findFirst({
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

async function getPrimarySalon() {
  return prisma.salon.findFirst({ orderBy: { createdAt: "asc" } });
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

server.get("/api/dashboard", async (request) => {
  const query = dateQuerySchema.parse(request.query);
  return buildDashboardFromDatabase(query.date ?? currentDateInJapan());
});

server.get("/api/staff", async () => {
  const salon = await getPrimarySalon();
  if (!salon) return [];
  return prisma.staff.findMany({ where: { salonId: salon.id, active: true }, orderBy: { sortOrder: "asc" } });
});

server.get("/api/services", async () => {
  const salon = await getPrimarySalon();
  if (!salon) return [];
  return prisma.service.findMany({ where: { salonId: salon.id, active: true }, orderBy: [{ category: "asc" }, { name: "asc" }] });
});

server.get("/api/admin/settings", async () => {
  const salon = await prisma.salon.findFirst({
    orderBy: { createdAt: "asc" },
    include: { settings: true }
  });

  if (!salon) {
    return { salon: null, settings: null };
  }

  return {
    salon: {
      id: salon.id,
      name: salon.name,
      timezone: salon.timezone
    },
    settings: salon.settings
  };
});

server.get("/api/admin/staff", async () => {
  const salon = await getPrimarySalon();
  if (!salon) return [];
  return prisma.staff.findMany({ where: { salonId: salon.id }, orderBy: { sortOrder: "asc" } });
});

server.get("/api/admin/menus", async () => {
  const salon = await getPrimarySalon();
  if (!salon) return [];
  return prisma.service.findMany({ where: { salonId: salon.id }, orderBy: { sortOrder: "asc" } });
});

server.get("/api/admin/categories", async () => {
  const salon = await getPrimarySalon();
  if (!salon) return [];
  return prisma.menuCategory.findMany({ where: { salonId: salon.id }, orderBy: { sortOrder: "asc" } });
});

server.get("/api/admin/equipment", async () => {
  const salon = await getPrimarySalon();
  if (!salon) return [];
  return prisma.equipment.findMany({ where: { salonId: salon.id }, orderBy: { sortOrder: "asc" } });
});

server.post("/api/reservations", async (request, reply) => {
  const input = createReservationSchema.parse(request.body);
  const salon = await getPrimarySalon();
  if (!salon) {
    return reply.code(409).send({ message: "店舗情報を先に登録してください。" });
  }

  const customer = await prisma.customer.create({
    data: {
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
      ? await prisma.service.findFirst({
          where: { id: input.serviceId, salonId: salon.id }
        })
      : null) ??
    (await prisma.service.findFirst({
      where: { salonId: salon.id, name: input.serviceName }
    })) ??
    (await prisma.service.create({
      data: {
        salonId: salon.id,
        name: input.serviceName,
        category: "Custom",
        durationMinutes: input.durationMinutes,
        price: 0,
        color: "#0891b2"
      }
    }));
  const startsAt = new Date(`${input.date}T${input.startTime}:00.000+09:00`);
  const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);

  const reservation = await prisma.reservation.create({
        data: {
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

  reply.code(201);
  return reservation;
});

server.patch("/api/reservations/:id/status", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const input = updateStatusSchema.parse(request.body);

  return prisma.reservation.update({
    where: { id: params.id },
    data: { status: input.status }
  });
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
