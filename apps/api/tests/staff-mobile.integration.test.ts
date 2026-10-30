import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const databaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("native staff ID tokens retain tenant, salon, permission and accounting boundaries", { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl!);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname.endsWith("_test"), "Use only an explicit local *_test database");
  process.env.DATABASE_URL = databaseUrl!; process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")]);
  server.log.level = "silent";
  const prefix = `native-staff-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [], programIds: string[] = [];
  const uid = (name: string) => `${prefix}-${name}`;
  const token = (name: string) => `${Buffer.from("header").toString("base64url")}.${Buffer.from(uid(name)).toString("base64url")}.signature`;
  const names = ["owner", "cashier", "viewer", "no-role"];
  const identities = new Map(names.map((name) => [token(name), { uid: uid(name), email: `${uid(name)}@example.test`, email_verified: true,
    name: `担当-${name}`, aud: "salon-reserve-bg", iss: "https://securetoken.google.com/salon-reserve-bg", firebase: { sign_in_provider: "password", identities: {} } }]));
  let verifiedTokens = 0;
  // Exercise the ID-token fallback, not a browser session cookie.
  t.mock.method(firebaseAdminAuth, "verifySessionCookie", async () => { throw new Error("not a session cookie"); });
  t.mock.method(firebaseAdminAuth, "verifyIdToken", async (credential: string, revoked?: boolean) => {
    assert.equal(revoked, true); verifiedTokens++; const identity = identities.get(credential); if (!identity) throw new Error("expired credential"); return identity as any;
  });
  const headers = (name = "owner", tenantSlug?: string, salonId?: string) => ({ authorization: `Bearer ${token(name)}`,
    ...(tenantSlug ? { "x-tenant-slug": tenantSlug } : {}), ...(salonId ? { "x-salon-id": salonId } : {}) });
  const inject = (method: "GET" | "POST", path: string, body?: unknown, auth: Record<string, string> = headers()) => server.inject({ method, url: path, headers: auth, ...(body === undefined ? {} : { payload: body }) });
  const date = "2026-10-30";
  try {
    const program = await prisma.membershipProgram.create({ data: { slug: prefix, name: "明示参加プログラム" } }); programIds.push(program.id);
    const privateProgram = await prisma.membershipProgram.create({ data: { slug: `${prefix}-private`, name: "非所属企業の制度" } }); programIds.push(privateProgram.id);
    async function tenant(name: string, programId: string | null, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
      const record = await prisma.tenant.create({ data: { slug: `${prefix}-${name}`, name: `会社-${name}`, membershipProgramId: programId, status } }); tenantIds.push(record.id);
      const first = await prisma.salon.create({ data: { tenantId: record.id, name: `店舗-${name}-1` } });
      const second = await prisma.salon.create({ data: { tenantId: record.id, name: `店舗-${name}-2` } });
      return { ...record, first, second };
    }
    const a = await tenant("a", program.id), b = await tenant("b", null), foreign = await tenant("foreign", privateProgram.id), stopped = await tenant("stopped", null, "SUSPENDED"), suspended = await tenant("suspended-membership", null);
    const users = new Map<string, string>();
    for (const name of names) {
      const user = await prisma.appUser.create({ data: { firebaseUid: uid(name), email: `${uid(name)}@example.test`, displayName: `担当-${name}` } }); users.set(name, user.id);
    }
    const ownerId = users.get("owner")!, cashierId = users.get("cashier")!;
    await prisma.tenantMembership.createMany({ data: [
      { userId: ownerId, tenantId: a.id, role: "OWNER", salonIds: [a.first.id] },
      { userId: ownerId, tenantId: b.id, role: "STAFF", useCustomPermissions: true, permissions: ["checkout.read"], salonIds: [b.first.id] },
      { userId: ownerId, tenantId: stopped.id, role: "OWNER" },
      { userId: ownerId, tenantId: suspended.id, role: "OWNER", status: "SUSPENDED" },
      { userId: cashierId, tenantId: a.id, role: "STAFF", useCustomPermissions: true, permissions: ["checkout.read", "checkout.write"], salonIds: [a.first.id] },
      { userId: users.get("viewer")!, tenantId: a.id, role: "VIEWER", salonIds: [a.first.id] },
    ] });
    const scoped = (name = "owner", row = a, salonId = row.first.id) => headers(name, row.slug, salonId);
    async function reservation(row: typeof a, salonId: string, name: string, day = date) {
      const scope = { tenantId: row.id, salonId };
      const customer = await prisma.customer.create({ data: { ...scope, name, kana: "カクニン", phone: "09011112222", memo: "private treatment chart", tags: ["private tag"] } });
      const service = await prisma.service.create({ data: { ...scope, name: "受付確認サービス", category: "test", price: 9800, durationMinutes: 60, color: "#111111" } });
      const record = await prisma.reservation.create({ data: { ...scope, customerId: customer.id, serviceId: service.id,
        startsAt: new Date(`${day}T10:00:00+09:00`), endsAt: new Date(`${day}T11:00:00+09:00`), status: "CONFIRMED", memo: "private reservation note" } });
      return { ...record, customer };
    }
    const first = await reservation(a, a.first.id, "当日・会計なし"), second = await reservation(a, a.first.id, "当日・会計あり");
    const hiddenSalon = await reservation(a, a.second.id, "別店舗のお客様"), hiddenCompany = await reservation(foreign, foreign.first.id, "別会社のお客様");
    await reservation(a, a.first.id, "別日の予約", "2026-10-31");
    const create = await inject("POST", "/api/cash/checkouts", { reservationId: second.id, requestId: randomUUID() }, scoped());
    assert.equal(create.statusCode, 201, create.body); const checkout = create.json();

    await t.test("context uses Firebase identity and current DB memberships without trusting scope headers", async () => {
      assert.equal((await inject("GET", "/api/staff/mobile/context", undefined, {})).statusCode, 401);
      assert.equal((await inject("GET", "/api/staff/mobile/context", undefined, { authorization: "Bearer expired" })).statusCode, 401);
      const result = await inject("GET", "/api/staff/mobile/context", undefined, scoped("owner", foreign));
      assert.equal(result.statusCode, 200, result.body); assert(verifiedTokens > 0);
      assert.equal(result.headers["cache-control"], "private, no-store");
      assert.equal(result.json().staff.id, ownerId);
      assert.deepEqual(new Set(result.json().tenants.map((entry: any) => entry.id)), new Set([a.id, b.id]));
      const primary = result.json().tenants.find((entry: any) => entry.id === a.id);
      assert.equal(primary.program.id, program.id); assert.equal(primary.role, "OWNER");
      assert.deepEqual(new Set(primary.salons.map((entry: any) => entry.id)), new Set([a.first.id, a.second.id]), "Owner scope follows the existing policy");
      const limited = result.json().tenants.find((entry: any) => entry.id === b.id);
      assert.equal(limited.program, null); assert.deepEqual(limited.salons.map((entry: any) => entry.id), [b.first.id]);
      assert.deepEqual(limited.permissions, ["checkout.read"]);
      assert(!result.body.includes(foreign.name)); assert(!result.body.includes(privateProgram.name));
      assert.equal((await prisma.tenant.findUniqueOrThrow({ where: { id: b.id } })).membershipProgramId, null, "Discovery never opts a company into a program");
      const noRole = await inject("GET", "/api/staff/mobile/context", undefined, headers("no-role")); assert.equal(noRole.statusCode, 200); assert.deepEqual(noRole.json().tenants, []);
      assert.equal((await inject("GET", "/api/staff/mobile/context?userId=another", undefined, headers())).statusCode, 400);
    });

    await t.test("target reads require an explicit, authorized tenant and salon pair", async () => {
      for (const auth of [headers(), headers("owner", a.slug), headers("owner", undefined, a.first.id)]) {
        const result = await inject("POST", "/api/staff/mobile/targets", { date }, auth); assert.equal(result.statusCode, 400, result.body);
      }
      assert.equal((await inject("POST", "/api/staff/mobile/targets", { date }, { "x-tenant-slug": a.slug, "x-salon-id": a.first.id })).statusCode, 401);
      assert.equal((await inject("POST", "/api/staff/mobile/targets", { date }, scoped("owner", foreign))).statusCode, 403);
      assert.equal((await inject("POST", "/api/staff/mobile/targets", { date }, scoped("cashier", a, a.second.id))).statusCode, 403);
      assert.equal((await inject("POST", "/api/staff/mobile/targets", { date }, { ...scoped(), "x-tenant-id": foreign.id })).statusCode, 403);
      assert.equal((await inject("POST", "/api/staff/mobile/targets", { date }, scoped("owner", a, b.first.id))).statusCode, 403);
      for (const body of [{ date: "2026-02-31" }, { date, page: 0 }, { date, pageSize: 31 }, { date, tenantId: foreign.id }]) {
        assert.equal((await inject("POST", "/api/staff/mobile/targets", body, scoped())).statusCode, 400);
      }
    });

    await t.test("reservation-capable operators receive only current-store minimal targets", async () => {
      const result = await inject("POST", "/api/staff/mobile/targets", { date }, scoped()); assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.headers["cache-control"], "private, no-store"); assert.equal(result.json().total, 2);
      assert.deepEqual(result.json().capabilities, { canReadReservations: true, canWriteCheckouts: true, canLinkCustomers: true });
      assert.deepEqual(new Set(result.json().targets.map((entry: any) => entry.customer.id)), new Set([first.customerId, second.customerId]));
      const withCheckout = result.json().targets.find((entry: any) => entry.checkout);
      assert.equal(withCheckout.checkout.id, checkout.id); assert.equal(withCheckout.checkout.status, "DRAFT");
      assert.equal(withCheckout.reservation.date, date); assert.equal(withCheckout.reservation.startTime, "10:00");
      assert(result.json().targets.some((entry: any) => entry.checkout === null));
      for (const field of ["phone", "memo", "tags", "notes", "projectId", "uid", "reference"]) assert(!result.body.includes(`"${field}"`));
      assert(!result.body.includes(hiddenSalon.customer.name)); assert(!result.body.includes(hiddenCompany.customer.name));
      const page = await inject("POST", "/api/staff/mobile/targets", { date, pageSize: 1, page: 2 }, scoped()); assert.equal(page.json().targets.length, 1); assert.equal(page.json().total, 2);
      const filtered = await inject("POST", "/api/staff/mobile/targets", { date, customerId: first.customerId }, scoped()); assert.equal(filtered.json().total, 1); assert.equal(filtered.json().targets[0].customer.id, first.customerId);
      const foreignCustomer = await inject("POST", "/api/staff/mobile/targets", { date, customerId: hiddenCompany.customerId }, scoped()); assert.equal(foreignCustomer.json().total, 0);
    });

    await t.test("cash-only access does not gain a list of reservations or customer-link permission", async () => {
      const context = await inject("GET", "/api/staff/mobile/context", undefined, headers("cashier"));
      assert.deepEqual(context.json().tenants[0].salons.map((entry: any) => entry.id), [a.first.id]);
      const result = await inject("POST", "/api/staff/mobile/targets", { date }, scoped("cashier")); assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().total, 1); assert.equal(result.json().targets[0].checkout.id, checkout.id);
      assert.equal(result.json().targets[0].reservation, null);
      assert.deepEqual(result.json().capabilities, { canReadReservations: false, canWriteCheckouts: true, canLinkCustomers: false });
      const viewer = await inject("POST", "/api/staff/mobile/targets", { date }, scoped("viewer")); assert.equal(viewer.statusCode, 200);
      assert.equal(viewer.json().capabilities.canWriteCheckouts, false); assert.equal(viewer.json().capabilities.canLinkCustomers, false);
    });

    await t.test("staff revocation, changed salon grants and disabled accounts apply on the next request", async () => {
      const key = { tenantId_userId: { tenantId: a.id, userId: cashierId } };
      await prisma.tenantMembership.update({ where: key, data: { status: "SUSPENDED" } });
      assert.deepEqual((await inject("GET", "/api/staff/mobile/context", undefined, headers("cashier"))).json().tenants, []);
      assert.equal((await inject("POST", "/api/staff/mobile/targets", { date }, scoped("cashier"))).statusCode, 403);
      await prisma.tenantMembership.update({ where: key, data: { status: "ACTIVE", salonIds: [a.second.id] } });
      assert.equal((await inject("POST", "/api/staff/mobile/targets", { date }, scoped("cashier"))).statusCode, 403);
      assert.deepEqual((await inject("GET", "/api/staff/mobile/context", undefined, headers("cashier"))).json().tenants[0].salons.map((entry: any) => entry.id), [a.second.id]);
      await prisma.tenantMembership.update({ where: key, data: { salonIds: [a.first.id] } });
      await prisma.appUser.update({ where: { id: cashierId }, data: { disabled: true } });
      assert.equal((await inject("GET", "/api/staff/mobile/context", undefined, headers("cashier"))).statusCode, 403);
      assert.equal((await inject("POST", "/api/staff/mobile/targets", { date }, scoped("cashier"))).statusCode, 403);
      await prisma.appUser.update({ where: { id: cashierId }, data: { disabled: false } });
    });

    await t.test("reading never performs a point mutation and obsolete standalone award routes do not exist", async () => {
      const before = await prisma.membershipPointEntry.count({ where: { tenantId: { in: tenantIds } } });
      for (const path of ["/rpc/record_visit_and_award_points", "/api/staff/mobile/record_visit_and_award_points"]) {
        assert.equal((await inject("POST", path, { memberId: randomUUID(), amountYen: 9800 }, scoped())).statusCode, 404);
      }
      assert.equal(await prisma.membershipPointEntry.count({ where: { tenantId: { in: tenantIds } } }), before);
      assert.equal((await prisma.cashCheckout.findUniqueOrThrow({ where: { id: checkout.id } })).status, "DRAFT");
      const audit = await prisma.auditLog.findMany({ where: { tenantId: a.id, action: { startsWith: "staff.mobile." } } }); assert(audit.length > 0);
      const metadata = JSON.stringify(audit.map((entry) => entry.metadata)); assert(!metadata.includes("09011112222")); assert(!metadata.includes("private treatment"));
    });

    await t.test("native discovery and target enumeration have one persistent per-user limit", async () => {
      const actorKey = `native-staff:${ownerId}`, programId = "staff-native-context", windowStartsAt = new Date(Math.floor(Date.now() / 600_000) * 600_000);
      await prisma.membershipLookupRateLimit.upsert({ where: { actorKey_programId_windowStartsAt: { actorKey, programId, windowStartsAt } },
        create: { actorKey, programId, windowStartsAt, attempts: 120 }, update: { attempts: 120 } });
      const limited = await inject("GET", "/api/staff/mobile/context"); assert.equal(limited.statusCode, 429, limited.body);
      assert.equal(limited.json().code, "STAFF_MOBILE_RATE_LIMIT");
      assert.equal((await inject("POST", "/api/staff/mobile/targets", { date }, scoped())).statusCode, 429);
    });
  } finally {
    const users = await prisma.appUser.findMany({ where: { firebaseUid: { startsWith: prefix } }, select: { id: true } });
    await prisma.$transaction(async (tx) => {
      await tx.membershipLookupRateLimit.deleteMany({ where: { actorKey: { in: users.map((user) => `native-staff:${user.id}`) } } });
      await tx.cashCheckoutItem.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await tx.cashPaymentAllocation.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await tx.cashCheckout.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      await tx.appUser.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
      await tx.membershipProgram.deleteMany({ where: { id: { in: programIds } } });
    });
    await server.close(); await prisma.$disconnect();
  }
});
