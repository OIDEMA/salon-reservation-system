import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { japanDate, japanDateTime } from "../src/member-booking-domain.js";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("member booking keeps token, owner, publication, inventory and retry boundaries intact", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl; process.env.API_DISABLE_LISTEN = "1";
  const prefix = `member-${randomUUID().slice(0, 8)}`;
  process.env.MEMBER_BOOKING_TENANTS = `${prefix}:missmrs`;
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")]);
  const tenants: string[] = []; const users: string[] = [];
  const identity = (uid: string) => ({ uid, aud: "salon-reserve-bg", iss: "https://securetoken.google.com/salon-reserve-bg", email: `${uid}@example.test`, email_verified: true, firebase: { sign_in_provider: "password", identities: {} } });
  const uidA = `${prefix}-a`; const uidB = `${prefix}-b`; const uidC = `${prefix}-c`; const uidAdmin = `${prefix}-admin`;
  const token = (uid: string) => `${Buffer.from("header").toString("base64url")}.${Buffer.from(uid).toString("base64url")}.signature`;
  const identities = new Map([uidA, uidB, uidC, uidAdmin].map((uid) => [token(uid), identity(uid)]));
  const tokenMock = t.mock.method(firebaseAdminAuth, "verifyIdToken", async (credential: string, revoked?: boolean) => { assert.equal(revoked, true); const claims = identities.get(credential); if (!claims) throw new Error("invalid"); return claims as any; });
  const sessionMock = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => { const claims = identities.get(credential); if (!claims) throw new Error("invalid"); return claims as any; });
  const headers = (uid = uidA) => ({ authorization: `Bearer ${token(uid)}` });
  const date = japanDate(new Date(Date.now() + 3 * 86_400_000));
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "会員API検証" } }); tenants.push(tenant.id);
    const hidden = await prisma.tenant.create({ data: { slug: `${prefix}-hidden`, name: "非公開検証" } }); tenants.push(hidden.id);
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "公開店舗" } });
    const hiddenSalon = await prisma.salon.create({ data: { tenantId: hidden.id, name: "非公開店舗" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    const settings = await prisma.salonSettings.create({ data: { ...scope, storeId: prefix, openTime: "09:00", closeTime: "20:00", maxConcurrentReservations: 1,
      cancellationMessage: "", friendMessage: "", candidateIntervalMinutes: 30, bookingWindowValue: "1ヶ月先",
      notifyReservationEmail: true, notificationEmail: "booking-notice@example.test" } });
    const category = await prisma.menuCategory.create({ data: { ...scope, name: "公開カテゴリ", type: "MENU" } });
    await prisma.menuCategory.create({ data: { ...scope, name: "停止カテゴリ", type: "MENU", enabled: false } });
    const menu = await prisma.service.create({ data: { ...scope, name: "公開メニュー", category: category.name, durationMinutes: 30, price: 5000, color: "#111111" } });
    const inactive = await prisma.service.create({ data: { ...scope, name: "停止メニュー", category: category.name, durationMinutes: 30, price: 6000, active: false, color: "#222222" } });
    const privateMenu = await prisma.service.create({ data: { ...scope, name: "非公開メニュー", category: category.name, durationMinutes: 30, price: 7000, lineVisible: false, color: "#333333" } });
    await prisma.service.create({ data: { ...scope, name: "カテゴリ停止", category: "停止カテゴリ", durationMinutes: 30, price: 8000, color: "#444444" } });
    const staff = await prisma.staff.create({ data: { ...scope, name: "公開担当", kana: "コウカイ", role: "ESTHETICIAN", color: "#111111", nominationFee: 500 } });
    const stoppedStaff = await prisma.staff.create({ data: { ...scope, name: "停止担当", kana: "テイシ", role: "ESTHETICIAN", color: "#222222", active: false } });
    await prisma.staff.create({ data: { ...scope, name: "管理設備", kana: "セツビ", role: "ROOM_RESOURCE", color: "#333333" } });
    await prisma.shift.create({ data: { ...scope, staffId: staff.id, type: "AVAILABLE", label: "出勤", startsAt: japanDateTime(date, "09:00"), endsAt: japanDateTime(date, "20:00") } });
    const oldCustomer = await prisma.customer.create({ data: { ...scope, name: "会員", kana: "カイイン", phone: "090-1234-5678", memo: "private medical text" } });
    const old = await prisma.reservation.create({ data: { ...scope, customerId: oldCustomer.id, serviceId: menu.id, staffId: staff.id,
      startsAt: japanDateTime(date, "18:00"), endsAt: japanDateTime(date, "18:30"), status: "CONFIRMED" } });
    const admin = await prisma.appUser.create({ data: { firebaseUid: uidAdmin, email: `${uidAdmin}@example.test` } }); users.push(admin.id);
    await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: admin.id, role: "OWNER" } });
    const adminHeaders = { ...headers(uidAdmin), "x-tenant-slug": tenant.slug, "x-salon-id": salon.id };
    const customer = { name: "会員", kana: "カイイン", phone: "090-1234-5678" };
    let expectedPrice = 5500;
    const input = (startTime = "10:00") => ({ expectedPrice, expectedDurationMinutes: 30, salonId: salon.id, serviceId: menu.id, staffId: staff.id, date, startTime, customer });
    const create = (value: Record<string, unknown> = input(), key = randomUUID(), uid = uidA) => server.inject({ method: "POST", url: "/api/member/reservations", headers: { ...headers(uid), "idempotency-key": key }, payload: value });
    const cancel = (id: string, uid = uidA) => server.inject({ method: "POST", url: `/api/member/reservations/${id}/cancel`, headers: headers(uid), payload: {} });
    const list = (uid = uidA, query = "") => server.inject({ method: "GET", url: `/api/member/reservations${query}`, headers: headers(uid) });

    await t.test("catalog is explicitly published and excludes stopped/private/admin data", async () => {
      const response = await server.inject({ url: "/api/member/catalog", headers: headers() }); assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "private, no-store");
      const body = response.json(); assert.equal(body.paymentMode, "pay_at_salon"); assert.deepEqual(body.salons.map((item: any) => item.id), [salon.id]);
      assert.deepEqual(body.salons[0].menus.map((item: any) => item.id), [menu.id]); assert.deepEqual(body.salons[0].staff.map((item: any) => item.id), [staff.id]);
      for (const field of ["tenantId", "customerId", "memo", "parallelCapacity", "allocationOrder", "kana", "tags"]) assert(!JSON.stringify(body).includes(`"${field}"`));
      assert.equal((await server.inject({ url: `/api/member/availability?salonId=${hiddenSalon.id}&serviceId=${menu.id}&date=${date}`, headers: headers() })).statusCode, 404);
    });
    await t.test("availability uses server amount, working shifts, date window and public masters", async () => {
      const availability = await server.inject({ url: `/api/member/availability?salonId=${salon.id}&serviceId=${menu.id}&date=${date}`, headers: headers() }); assert.equal(availability.statusCode, 200, availability.body);
      const slot = availability.json().slots.find((item: any) => item.startTime === "10:00"); assert(slot); assert.equal(slot.price, 5500); assert.equal(slot.durationMinutes, 30); assert.equal(slot.staffId, staff.id);
      assert(!availability.body.includes(oldCustomer.name));
      for (const serviceId of [inactive.id, privateMenu.id]) assert.equal((await server.inject({ url: `/api/member/availability?salonId=${salon.id}&serviceId=${serviceId}&date=${date}`, headers: headers() })).statusCode, 400);
      assert.equal((await server.inject({ url: `/api/member/availability?salonId=${salon.id}&serviceId=${menu.id}&date=2099-01-01`, headers: headers() })).statusCode, 400);
      assert.equal((await server.inject({ url: `/api/member/availability?salonId=${salon.id}&serviceId=${menu.id}&staffId=${stoppedStaff.id}&date=${date}`, headers: headers() })).statusCode, 400);
    });
    let reservationId = "";
    await t.test("creation takes identity from token and never connects matching legacy contact", async () => {
      assert.equal((await list()).json().total, 0);
      const response = await create(); assert.equal(response.statusCode, 201, response.body); const reservation = response.json().reservation; reservationId = reservation.id;
      assert.equal(reservation.price, 5500); assert.equal(reservation.status, "CONFIRMED"); assert.equal(reservation.paymentStatus, "UNPAID"); assert(reservation.canCancel);
      const saved = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } }); assert.notEqual(saved.customerId, oldCustomer.id); assert.equal(saved.source, "MINI_APP");
      const notification = await prisma.emailOutbox.findUniqueOrThrow({ where: { eventKey: `reservation.created:${reservationId}` } });
      assert.equal(notification.eventType, "reservation.created"); assert.equal(notification.status, "PENDING");
      assert.equal(notification.recipientEmail, "booking-notice@example.test"); assert.equal(notification.tenantId, tenant.id); assert.equal(notification.salonId, salon.id);
      assert.deepEqual(notification.payload, { reservationId, salonName: salon.name, startsAt: japanDateTime(date, "10:00").toISOString(),
        serviceName: menu.name, tenantSlug: tenant.slug });
      assert.equal(await prisma.emailOutbox.count({ where: { eventKey: `reservation.created:${reservationId}` } }), 1);
      assert.equal(await prisma.memberCustomerLink.count({ where: { uid: uidA, customerId: saved.customerId } }), 1);
      const own = await list(); assert.equal(own.json().total, 1); assert.equal(own.json().reservations[0].id, reservationId); assert(!own.body.includes(old.id)); assert(!own.body.includes("private medical"));
      assert.equal((await list(uidB)).json().total, 0); assert.equal((await cancel(reservationId, uidB)).statusCode, 404);
      assert.equal((await cancel(old.id)).statusCode, 404); assert.equal((await server.inject({ url: "/api/admin/customers", headers: headers() })).statusCode, 400);
    });
    await t.test("price and duration preconditions cannot set amounts or silently accept changed quotes", async () => {
      const before = await prisma.reservation.count({ where: scope });
      const priceChanged = await create({ ...input("10:30"), expectedPrice: 1 }); assert.equal(priceChanged.statusCode, 409, priceChanged.body); assert.equal(priceChanged.json().code, "PRICE_CHANGED");
      const durationChanged = await create({ ...input("10:30"), expectedDurationMinutes: 5 }); assert.equal(durationChanged.statusCode, 409, durationChanged.body); assert.equal(durationChanged.json().code, "DURATION_CHANGED");
      assert.equal(await prisma.reservation.count({ where: scope }), before);
    });
    await t.test("forged fields, missing keys, inactive masters and mismatched scopes fail without writes", async () => {
      const before = await prisma.reservation.count({ where: scope });
      for (const payload of [{ ...input("10:30"), price: 1 }, { ...input("10:30"), customerId: oldCustomer.id }, { ...input("10:30"), status: "PAID" }]) assert.equal((await create(payload)).statusCode, 400);
      assert.equal((await server.inject({ method: "POST", url: "/api/member/reservations", headers: headers(), payload: input("10:30") })).statusCode, 400);
      assert.equal((await create({ ...input("10:30"), serviceId: inactive.id })).statusCode, 400);
      assert.equal((await create({ ...input("10:30"), salonId: hiddenSalon.id })).statusCode, 404);
      assert.equal((await create({ ...input("10:30"), staffId: stoppedStaff.id })).statusCode, 400);
      assert.equal(await prisma.reservation.count({ where: scope }), before);
    });
    await t.test("idempotent retries return one booking, preserve amount snapshot and bind payload/owner", async () => {
      const key = randomUUID();
      const originalPayload = { ...input("11:00"), customer: { name: "連絡先更新", kana: "レンラクサキ", phone: "090-2222-3333" } };
      const first = await create(originalPayload, key); assert.equal(first.statusCode, 201, first.body);
      const eventKey = `reservation.created:${first.json().reservation.id}`;
      assert.equal(await prisma.emailOutbox.count({ where: { eventKey } }), 1);
      const outboxCountBeforeReplay = await prisma.emailOutbox.count({ where: scope });
      const ownerLink = await prisma.memberCustomerLink.findUniqueOrThrow({ where: { projectId_uid_tenantId_salonId: { projectId: "salon-reserve-bg", uid: uidA, ...scope } } });
      const ownContact = await prisma.customer.findUniqueOrThrow({ where: { id: ownerLink.customerId } });
      assert.equal(ownContact.name, "連絡先更新"); assert.equal(ownContact.kana, "レンラクサキ"); assert.equal(ownContact.phone, "090-2222-3333");
      const untouchedContact = await prisma.customer.findUniqueOrThrow({ where: { id: oldCustomer.id } });
      assert.equal(untouchedContact.phone, customer.phone); assert.equal(untouchedContact.name, customer.name); assert.equal(untouchedContact.memo, "private medical text");
      await prisma.service.update({ where: { id: menu.id }, data: { price: 9000, durationMinutes: 45 } });
      expectedPrice = 9500;
      const retry = await create(originalPayload, key); assert.equal(retry.statusCode, 200, retry.body); assert.equal(retry.json().reservation.id, first.json().reservation.id); assert.equal(retry.json().reservation.price, 5500); assert.equal(retry.json().reservation.durationMinutes, 30);
      assert.equal(await prisma.emailOutbox.count({ where: { eventKey } }), 1);
      assert.equal(await prisma.emailOutbox.count({ where: scope }), outboxCountBeforeReplay);
      await prisma.service.update({ where: { id: menu.id }, data: { durationMinutes: 30 } });
      const adminList = await server.inject({ url: "/api/reservations/page", headers: adminHeaders });
      assert.equal(adminList.statusCode, 200, adminList.body);
      assert.equal(adminList.json().reservations.find((reservation: any) => reservation.id === first.json().reservation.id).service.price, 5500);
      const adminDetail = await server.inject({ url: `/api/reservations/${first.json().reservation.id}`, headers: adminHeaders });
      assert.equal(adminDetail.statusCode, 200, adminDetail.body); assert.equal(adminDetail.json().service.price, 5500);
      const dashboard = await server.inject({ url: `/api/dashboard?date=${date}`, headers: adminHeaders });
      assert.equal(dashboard.statusCode, 200, dashboard.body); assert.equal(dashboard.json().reservations.find((reservation: any) => reservation.id === first.json().reservation.id).price, 5500);
      const receipt = await server.inject({ method: "POST", url: "/api/cash/checkouts", headers: adminHeaders,
        payload: { reservationId: first.json().reservation.id, requestId: randomUUID() } });
      assert.equal(receipt.statusCode, 201, receipt.body); assert.equal(receipt.json().totalYen, 5500); assert.equal(receipt.json().items[0].unitPriceYen, 5500);
      const register = await server.inject({ method: "POST", url: "/api/cash/register-sessions", headers: adminHeaders,
        payload: { businessDate: japanDate(new Date()), openingCashYen: 0, requestId: randomUUID() } });
      assert.equal(register.statusCode, 200, register.body);
      const draft = receipt.json();
      const prepared = await server.inject({ method: "PUT", url: `/api/cash/checkouts/${draft.id}`, headers: adminHeaders, payload: {
        version: draft.version, items: draft.items.map(({ label, quantity, unitPriceYen, discountYen, taxRate }: any) => ({ label, quantity, unitPriceYen, discountYen, taxRate })),
        payments: [{ method: "CARD", amountYen: 5500, reference: "検証" }], legacyPaidAcknowledged: false, notes: "" } });
      assert.equal(prepared.statusCode, 200, prepared.body);
      const finalized = await server.inject({ method: "POST", url: `/api/cash/checkouts/${draft.id}/finalize`, headers: adminHeaders,
        payload: { version: prepared.json().version, requestId: randomUUID(), registerSessionId: register.json().id } });
      assert.equal(finalized.statusCode, 200, finalized.body);
      const reversed = await server.inject({ method: "POST", url: `/api/cash/checkouts/${draft.id}/reverse`, headers: adminHeaders,
        payload: { requestId: randomUUID(), reason: "会員価格の訂正検証", refundRecorded: true, registerSessionId: register.json().id } });
      assert.equal(reversed.statusCode, 200, reversed.body);
      const corrected = await server.inject({ method: "POST", url: "/api/cash/checkouts", headers: adminHeaders,
        payload: { reservationId: first.json().reservation.id, requestId: randomUUID() } });
      assert.equal(corrected.statusCode, 201, corrected.body); assert.equal(corrected.json().supersedesCheckoutId, draft.id); assert.equal(corrected.json().totalYen, 5500);
      const refreshed = await server.inject({ method: "POST", url: `/api/cash/checkouts/${corrected.json().id}/refresh-reservation`, headers: adminHeaders, payload: { version: corrected.json().version } });
      assert.equal(refreshed.statusCode, 200, refreshed.body); assert.equal(refreshed.json().totalYen, 5500);
      assert.equal((await create(input("11:30"), key)).statusCode, 409);
      const other = await create(input("11:30"), key, uidB); assert.equal(other.statusCode, 201, other.body); assert.notEqual(other.json().reservation.id, first.json().reservation.id);
      const sameKey = randomUUID(); const responses = await Promise.all([create(input("12:00"), sameKey, uidB), create(input("12:00"), sameKey, uidB)]);
      assert(responses.every((response) => [200, 201].includes(response.statusCode)), responses.map((response) => response.body).join("\n"));
      assert.equal(responses[0].json().reservation.id, responses[1].json().reservation.id);
      // A later staff correction must not let the original key disclose another customer's reservation.
      const reassignedId = responses[0].json().reservation.id;
      const reassigned = await server.inject({ method: "PATCH", url: `/api/reservations/${reassignedId}`, headers: adminHeaders, payload: { customerId: oldCustomer.id } });
      assert.equal(reassigned.statusCode, 200, reassigned.body);
      const oldOwnerReplay = await create(input("12:00"), sameKey, uidB); assert.equal(oldOwnerReplay.statusCode, 404, oldOwnerReplay.body);
      assert(!(await list(uidB)).json().reservations.some((reservation: any) => reservation.id === reassignedId));
    });
    await t.test("competing member creates and management creates serialize on the same salon", async () => {
      const responses = await Promise.all([create(input("13:00"), randomUUID(), uidA), create(input("13:00"), randomUUID(), uidB)]);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
      const adminCreate = server.inject({ method: "POST", url: "/api/reservations", headers: adminHeaders, payload: { date, startTime: "14:00", durationMinutes: 30,
        serviceId: menu.id, serviceName: menu.name, staffId: staff.id, customerId: oldCustomer.id, customerName: oldCustomer.name, status: "CONFIRMED" } });
      const mixed = await Promise.all([create(input("14:00"), randomUUID(), uidB), adminCreate]); assert.deepEqual(mixed.map((response) => response.statusCode).sort(), [201, 409], mixed.map((response) => response.body).join("\n"));
      assert.equal(await prisma.reservation.count({ where: { ...scope, startsAt: japanDateTime(date, "14:00"), status: "CONFIRMED" } }), 1);
    });
    await t.test("disabled notification or missing recipient does not enqueue mail", async () => {
      const previousCount = await prisma.emailOutbox.count({ where: scope });
      await prisma.salonSettings.update({ where: { id: settings.id }, data: { notifyReservationEmail: false } });
      const disabled = await create(input("15:30"), randomUUID(), uidB); assert.equal(disabled.statusCode, 201, disabled.body);
      assert.equal(await prisma.emailOutbox.count({ where: { eventKey: `reservation.created:${disabled.json().reservation.id}` } }), 0);
      await prisma.salonSettings.update({ where: { id: settings.id }, data: { notifyReservationEmail: true, notificationEmail: null } });
      const withoutRecipient = await create(input("16:30"), randomUUID(), uidB); assert.equal(withoutRecipient.statusCode, 201, withoutRecipient.body);
      assert.equal(await prisma.emailOutbox.count({ where: { eventKey: `reservation.created:${withoutRecipient.json().reservation.id}` } }), 0);
      assert.equal(await prisma.emailOutbox.count({ where: scope }), previousCount);
      await prisma.salonSettings.update({ where: { id: settings.id }, data: { notificationEmail: "booking-notice@example.test" } });
    });
    await t.test("pagination is handled in the database and rejects unbounded input", async () => {
      const one = await list(uidA, "?page=1&pageSize=1"); const two = await list(uidA, "?page=2&pageSize=1");
      assert.equal(one.json().reservations.length, 1); assert.equal(two.json().reservations.length, 1); assert.notEqual(one.json().reservations[0].id, two.json().reservations[0].id);
      assert(one.json().total >= 2); assert.equal(one.json().pageSize, 1); assert.equal((await list(uidA, "?pageSize=100000")).statusCode, 400);
      assert.equal((await list(uidA, "?uid=other")).statusCode, 400);
    });
    await t.test("booking and cancellation cutoffs, paid states and cancellation retries are enforced", async () => {
      await prisma.salonSettings.update({ where: { id: settings.id }, data: { reservationCutoffDays: 365 } });
      assert.equal((await create(input("15:00"), randomUUID(), uidB)).statusCode, 409);
      await prisma.salonSettings.update({ where: { id: settings.id }, data: { reservationCutoffDays: 1, cancellationCutoffDays: 365 } });
      assert.equal((await cancel(reservationId)).statusCode, 409);
      await prisma.salonSettings.update({ where: { id: settings.id }, data: { cancellationCutoffDays: 1 } });
      await prisma.reservation.update({ where: { id: reservationId }, data: { paymentStatus: "PAID" } }); assert.equal((await cancel(reservationId)).statusCode, 409);
      await prisma.reservation.update({ where: { id: reservationId }, data: { paymentStatus: "UNPAID" } });
      const canceled = await cancel(reservationId); assert.equal(canceled.statusCode, 200, canceled.body); assert.equal(canceled.json().reservation.status, "CANCELLED");
      assert.equal((await cancel(reservationId)).statusCode, 200); assert.equal(await prisma.auditLog.count({ where: { resourceId: reservationId, action: "member.reservation.cancel" } }), 1);
    });
    await t.test("future reservation limit is enforced from persisted owner links", async () => {
      const cappedCustomer = await prisma.customer.create({ data: { ...scope, name: "上限検証", kana: "ジョウゲン" } });
      await prisma.memberCustomerLink.create({ data: { ...scope, projectId: "salon-reserve-bg", uid: uidC, customerId: cappedCustomer.id } });
      const future = new Date(japanDateTime(date, "10:00").getTime() + 86_400_000);
      await prisma.reservation.createMany({ data: Array.from({ length: 8 }, (_, index) => ({ ...scope, customerId: cappedCustomer.id, serviceId: menu.id,
        startsAt: new Date(future.getTime() + index * 3_600_000), endsAt: new Date(future.getTime() + index * 3_600_000 + 1_800_000), status: "CONFIRMED" as const })) });
      const blocked = await create(input("16:00"), randomUUID(), uidC); assert.equal(blocked.statusCode, 409, blocked.body); assert.equal(blocked.json().code, "BOOKING_LIMIT");
    });
    await t.test("cutoff is checked again after transaction waits and immediately before cancellation", async () => {
      const [{ default: Fastify }, { registerMemberBookingRoutes }] = await Promise.all([import("fastify"), import("../src/member-booking-routes.js")]);
      const app = Fastify();
      const cutoff = japanDateTime(japanDate(new Date(japanDateTime(date).getTime() - 86_400_000)), "21:30");
      let clockCalls = 0;
      registerMemberBookingRoutes(app, { database: prisma, authenticate: async () => ({ projectId: "salon-reserve-bg", uid: uidC }),
        publication: () => new Map([[prefix, "missmrs"]]), now: () => new Date(cutoff.getTime() + (clockCalls++ === 0 ? -1000 : 1000)) });
      try {
        const before = await prisma.reservation.count({ where: scope });
        const expired = await app.inject({ method: "POST", url: "/api/member/reservations", headers: { "idempotency-key": randomUUID() }, payload: input("16:00") });
        assert.equal(expired.statusCode, 409, expired.body); assert.equal(expired.json().code, "SLOT_UNAVAILABLE");
        assert.equal(await prisma.reservation.count({ where: scope }), before);
        const link = await prisma.memberCustomerLink.findUniqueOrThrow({ where: { projectId_uid_tenantId_salonId: { projectId: "salon-reserve-bg", uid: uidC, ...scope } } });
        const cancellable = await prisma.reservation.create({ data: { ...scope, customerId: link.customerId, serviceId: menu.id, staffId: staff.id,
          startsAt: japanDateTime(date, "17:00"), endsAt: japanDateTime(date, "17:30"), status: "CONFIRMED" } });
        clockCalls = 0;
        const lateCancel = await app.inject({ method: "POST", url: `/api/member/reservations/${cancellable.id}/cancel`, payload: {} });
        assert.equal(lateCancel.statusCode, 409, lateCancel.body); assert.equal(lateCancel.json().code, "CANCELLATION_UNAVAILABLE");
        assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: cancellable.id } })).status, "CONFIRMED");
      } finally { await app.close(); }
    });
    await t.test("durable attempt rate limit includes failed requests and owner key cannot bypass it", async () => {
      const windowStartsAt = new Date(Math.floor(Date.now() / 600_000) * 600_000);
      await prisma.memberBookingRateLimit.upsert({ where: { projectId_uid_windowStartsAt: { projectId: "salon-reserve-bg", uid: uidA, windowStartsAt } },
        create: { projectId: "salon-reserve-bg", uid: uidA, windowStartsAt, attempts: 10 }, update: { attempts: 10 } });
      const blocked = await create(input("16:00")); assert.equal(blocked.statusCode, 429, blocked.body);
      assert.equal(await prisma.reservation.count({ where: { ...scope, startsAt: japanDateTime(date, "16:00") } }), 0);
    });
  } finally {
    await server.close(); tokenMock.mock.restore(); sessionMock.mock.restore();
    await prisma.emailOutbox.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.memberReservationRequest.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.memberBookingRateLimit.deleteMany({ where: { uid: { in: [uidA, uidB, uidC, uidAdmin] } } });
    if (tenants.length) {
      const where = { tenantId: { in: tenants } };
      await prisma.cashRegisterMovement.deleteMany({ where });
      await prisma.cashCheckoutItem.deleteMany({ where });
      await prisma.cashPaymentAllocation.deleteMany({ where });
      const checkouts = await prisma.cashCheckout.findMany({ where, orderBy: { createdAt: "desc" }, select: { id: true, tenantId: true } });
      for (const checkout of checkouts) await prisma.cashCheckout.deleteMany({ where: { id: checkout.id, tenantId: checkout.tenantId } });
      await prisma.cashRegisterSession.deleteMany({ where });
      await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    }
    if (users.length) await prisma.appUser.deleteMany({ where: { id: { in: users } } }); await prisma.$disconnect();
  }
});
