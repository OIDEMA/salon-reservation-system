import cors from "@fastify/cors";
import { LineMessageStatus, PaymentStatus, PrismaClient, ReservationSource, ReservationStatus } from "@prisma/client";
import Fastify from "fastify";
import { z } from "zod";
import { buildDemoDashboard } from "./demo-data.js";

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
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2026-06-28")
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

async function buildDashboardFromDatabase(date: string) {
  const { start, end } = dayBounds(date);
  const salon = await prisma.salon.findFirst({
    include: {
      staff: { orderBy: { sortOrder: "asc" } },
      notifications: {
        where: { readAt: null },
        orderBy: { createdAt: "desc" },
        take: 6
      }
    }
  });

  if (!salon) {
    return buildDemoDashboard(date);
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

  return {
    date,
    salon: {
      id: salon.id,
      name: salon.name,
      timezone: salon.timezone,
      plan: "Growth"
    },
    hours: {
      start: "09:00",
      end: "20:00",
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
    suggestions: [
      {
        id: "sg-db-001",
        title: "高リスクの未確認予約から順にLINE再送",
        impact: "確認漏れを即時圧縮",
        priority: pendingCount > 3 ? "high" : "medium"
      },
      {
        id: "sg-db-002",
        title: "60分以上の空き枠へ待ち客を自動提案",
        impact: "当日売上の取りこぼし削減",
        priority: "medium"
      }
    ],
    summary: {
      revenue,
      pendingCount,
      confirmedCount: mappedReservations.filter((reservation) => reservation.status === "CONFIRMED").length,
      occupancyRate: 72,
      waitlistCount: mappedReservations.filter((reservation) => reservation.status === "WAITLIST").length,
      noShowRiskCount: mappedReservations.filter((reservation) => reservation.riskScore >= 50).length,
      lineReadRate: 81,
      averageTicket: Math.round(revenue / Math.max(1, mappedReservations.filter((reservation) => reservation.price > 0).length))
    }
  };
}

async function withDemoFallback<TDatabase, TFallback>(operation: () => Promise<TDatabase>, fallback: () => TFallback | Promise<TFallback>): Promise<TDatabase | TFallback> {
  try {
    return await operation();
  } catch (error) {
    server.log.warn({ error }, "database unavailable; serving demo data");
    return await fallback();
  }
}

async function getPrimarySalon() {
  return prisma.salon.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
}

const demoAdmin = {
  settings: {
    salon: {
      id: "salon-boneedz",
      name: "Boneedz丸亀店",
      timezone: "Asia/Tokyo"
    },
    settings: {
      storeId: "14805",
      openTime: "09:00",
      closeTime: "22:00",
      closedDays: ["月"],
      maxConcurrentReservations: 7,
      bookingWindowValue: "1ヶ月先",
      reservationCutoffMode: "previous_day",
      reservationCutoffDays: 1,
      reservationCutoffTime: "21:30",
      cancellationCutoffMode: "previous_day",
      cancellationCutoffDays: 1,
      cancellationCutoffTime: "21:30",
      multiMenuBooking: true,
      autoAssignUnspecified: true,
      lineThemeColor: "#ff0000",
      categoryDisplayMode: "collapsed",
      candidateIntervalMinutes: 30,
      calendarDefaultView: "week",
      calendarDisplayMode: "collapsed",
      notifyReservationEmail: true,
      notifyReservationLine: false,
      notifyCancellation: true,
      notifyCancellationEmail: true,
      notifyCancellationLine: false,
      cancellationMessage: "ご予約に関しましてキャンセル扱いとなりましたので通知いたします。",
      friendMessage: "お客様情報の登録を行います。1分程度で完了しますのでご協力お願いいたします。",
      preReservationMessage: "ご予約前に体調・既往歴・ご希望を確認いたします。",
      questionsEnabled: false,
      paymentEnabled: false,
      acceptingReservations: true
    }
  },
  staff: [
    { id: "staff-nozaki", name: "野崎光誠", kana: "ノザキ コウセイ", role: "STYLIST", color: "#16a34a", imageUrl: "https://placehold.co/160x180/ef4444/ffffff?text=Nozaki", nominationFee: 0, comment: "", allocationOrder: 2, parallelCapacity: 1, active: true, sortOrder: 1 },
    { id: "staff-maeda", name: "前田和樹", kana: "マエダ カズキ", role: "STYLIST", color: "#22c55e", imageUrl: "https://placehold.co/160x180/dc2626/ffffff?text=Maeda", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 2 },
    { id: "staff-hamada", name: "濵田　浩司", kana: "ハマダ コウジ", role: "STYLIST", color: "#0ea5e9", imageUrl: "https://placehold.co/160x180/b91c1c/ffffff?text=Hamada", nominationFee: 0, comment: "", allocationOrder: 2, parallelCapacity: 1, active: true, sortOrder: 3 },
    { id: "staff-shingu", name: "新宮明日香", kana: "シングウ アスカ", role: "STYLIST", color: "#ec4899", imageUrl: "https://placehold.co/160x180/f43f5e/ffffff?text=Shingu", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 4 },
    { id: "staff-morita", name: "森田直美", kana: "モリタ ナオミ", role: "MANAGER", color: "#0f766e", imageUrl: "https://placehold.co/160x180/e11d48/ffffff?text=Morita", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 5 },
    { id: "staff-yamamoto", name: "山本翔瑛", kana: "ヤマモト ショウエイ", role: "STYLIST", color: "#2563eb", imageUrl: "https://placehold.co/160x180/dc2626/ffffff?text=Yamamoto", nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 7 },
    { id: "staff-esthe", name: "エステ", kana: "エステ", role: "ROOM_RESOURCE", color: "#9333ea", imageUrl: null, nominationFee: 0, comment: "", allocationOrder: 1, parallelCapacity: 1, active: true, sortOrder: 10 }
  ],
  menus: [
    { id: "menu-training-30", name: "３０分パーソナルトレーニング", category: "パーソナルトレーニング", imageUrl: null, description: "30分コースのご利用になります", durationMinutes: 30, price: 0, color: "#16a34a", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 1, active: true },
    { id: "menu-training-60", name: "６０分パーソナルトレーニング", category: "パーソナルトレーニング", imageUrl: null, description: "60分コースのご利用になります", durationMinutes: 60, price: 0, color: "#16a34a", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 2, active: true },
    { id: "menu-seitai-60", name: "【整体】60分", category: "整体", imageUrl: null, description: "骨盤、猫背矯正など歪みを取りながらもみほぐしします", durationMinutes: 60, price: 10000, color: "#0f766e", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 4, active: true },
    { id: "menu-esthe-body", name: "【エステ】ボディケア", category: "エステ", imageUrl: null, description: "全身オイルマッサージ、美容液導入、疲労回復、リラクゼーション", durationMinutes: 120, price: 20000, color: "#9333ea", menuType: "通常メニュー", lineVisible: true, unlimitedBooking: true, sortOrder: 9, active: true }
  ],
  categories: [
    { id: "cat-training", name: "パーソナルトレーニング", type: "MENU", description: "30分・60分のトレーニング枠", imageUrl: null, enabled: true, sortOrder: 1 },
    { id: "cat-seitai", name: "整体", type: "MENU", description: "骨盤・猫背矯正、もみほぐし", imageUrl: null, enabled: true, sortOrder: 2 },
    { id: "cat-momihogushi", name: "もみほぐし", type: "MENU", description: "疲労回復とリラクゼーション", imageUrl: null, enabled: true, sortOrder: 3 },
    { id: "cat-esthe", name: "エステ", type: "MENU", description: "フェイシャル、ボディ、ハーブ蒸し", imageUrl: null, enabled: true, sortOrder: 4 }
  ],
  equipment: [
    { id: "eq-training", name: "トレーニングブース A", capacity: 2, allocationOrder: 1, color: "#16a34a", memo: "パーソナルトレーニング優先", active: true, sortOrder: 1 },
    { id: "eq-bed-1", name: "整体ベッド 1", capacity: 1, allocationOrder: 1, color: "#0f766e", memo: "整体・もみほぐし", active: true, sortOrder: 2 },
    { id: "eq-bed-2", name: "整体ベッド 2", capacity: 1, allocationOrder: 2, color: "#0ea5e9", memo: "混雑時の自動割当", active: true, sortOrder: 3 },
    { id: "eq-esthe", name: "エステ個室", capacity: 1, allocationOrder: 1, color: "#9333ea", memo: "フェイシャル/ボディ専用", active: true, sortOrder: 4 }
  ]
};

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
  return withDemoFallback(() => buildDashboardFromDatabase(query.date), () => buildDemoDashboard(query.date));
});

server.get("/api/staff", async () =>
  withDemoFallback(
    async () => {
      const salon = await getPrimarySalon();
      return prisma.staff.findMany({ where: { salonId: salon.id, active: true }, orderBy: { sortOrder: "asc" } });
    },
    () => buildDemoDashboard().rows.filter((row) => row.type !== "unassigned")
  )
);

server.get("/api/services", async () =>
  withDemoFallback(
    async () => {
      const salon = await getPrimarySalon();
      return prisma.service.findMany({ where: { salonId: salon.id, active: true }, orderBy: [{ category: "asc" }, { name: "asc" }] });
    },
    () => [
      { id: "svc-cut", name: "カット", category: "Hair", durationMinutes: 60, price: 6600 },
      { id: "svc-color", name: "カラー + トリートメント", category: "Color", durationMinutes: 90, price: 15400 }
    ]
  )
);

server.get("/api/admin/settings", async () =>
  withDemoFallback(
    async () => {
      const salon = await prisma.salon.findFirstOrThrow({
        orderBy: { createdAt: "asc" },
        include: { settings: true }
      });

      return {
        salon: {
          id: salon.id,
          name: salon.name,
          timezone: salon.timezone
        },
        settings: salon.settings
      };
    },
    () => demoAdmin.settings
  )
);

server.get("/api/admin/staff", async () =>
  withDemoFallback(
    async () => {
      const salon = await getPrimarySalon();
      return prisma.staff.findMany({
        where: { salonId: salon.id },
        orderBy: { sortOrder: "asc" }
      });
    },
    () => demoAdmin.staff
  )
);

server.get("/api/admin/menus", async () =>
  withDemoFallback(
    async () => {
      const salon = await getPrimarySalon();
      return prisma.service.findMany({
        where: { salonId: salon.id },
        orderBy: { sortOrder: "asc" }
      });
    },
    () => demoAdmin.menus
  )
);

server.get("/api/admin/categories", async () =>
  withDemoFallback(
    async () => {
      const salon = await getPrimarySalon();
      return prisma.menuCategory.findMany({
        where: { salonId: salon.id },
        orderBy: { sortOrder: "asc" }
      });
    },
    () => demoAdmin.categories
  )
);

server.get("/api/admin/equipment", async () =>
  withDemoFallback(
    async () => {
      const salon = await getPrimarySalon();
      return prisma.equipment.findMany({
        where: { salonId: salon.id },
        orderBy: { sortOrder: "asc" }
      });
    },
    () => demoAdmin.equipment
  )
);

server.post("/api/reservations", async (request, reply) => {
  const input = createReservationSchema.parse(request.body);

  return withDemoFallback(
    async () => {
      const salon = await getPrimarySalon();
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
    },
    () => {
      reply.code(202);
      return {
        id: `demo-${Date.now()}`,
        ...input,
        status: "PENDING",
        lineMessageStatus: "QUEUED"
      };
    }
  );
});

server.patch("/api/reservations/:id/status", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const input = updateStatusSchema.parse(request.body);

  return withDemoFallback(
    () =>
      prisma.reservation.update({
        where: { id: params.id },
        data: { status: input.status }
      }),
    () => ({ id: params.id, status: input.status })
  );
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
