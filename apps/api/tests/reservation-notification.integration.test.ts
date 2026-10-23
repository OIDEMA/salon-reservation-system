import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("admin booking snapshots the saved customer and menu amount atomically for its salon notice", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl!; process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")
  ]);
  const prefix = `booking-email-${randomUUID().slice(0, 8)}`;
  let tenantId = ""; let userId = "";
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    assert.equal(credential, prefix); return { uid: prefix, email: `${prefix}@example.test`, email_verified: true };
  });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "通知検証テナント" } }); tenantId = tenant.id;
    const salon = await prisma.salon.create({ data: { tenantId, name: "通知検証店" } });
    const scope = { tenantId, salonId: salon.id };
    const user = await prisma.appUser.create({ data: { firebaseUid: prefix, email: `${prefix}@example.test` } }); userId = user.id;
    await prisma.tenantMembership.create({ data: { tenantId, userId, role: "OWNER" } });
    await prisma.salonSettings.create({ data: { ...scope, storeId: prefix, cancellationMessage: "", friendMessage: "",
      notifyReservationEmail: true, notificationEmail: "saved-admin@example.test" } });
    const customer = await prisma.customer.create({ data: { ...scope, name: "登録済み 顧客", kana: "コキャク", phone: "090-1234-5678", memo: "顧客の非公開メモ" } });
    const service = await prisma.service.create({ data: { ...scope, name: "予約時メニュー", category: "Test", durationMinutes: 30, price: 2200, color: "#000000" } });
    const staff = await prisma.staff.create({ data: { ...scope, name: "担当者", kana: "タントウ", role: "ESTHETICIAN", color: "#000000", nominationFee: 500 } });
    const headers = { authorization: `Bearer ${prefix}`, "x-tenant-slug": tenant.slug, "x-salon-id": salon.id };
    const payload = { date: "2035-01-10", startTime: "10:00", durationMinutes: 30, customerId: customer.id, customerName: "送信された別の名前",
      customerPhone: "080-0000-0000", serviceId: service.id, serviceName: "送信された別のメニュー", staffId: staff.id,
      status: "CONFIRMED", source: "PHONE", memo: "予約の非公開メモ" };
    const create = (extra: Record<string, unknown> = {}) => server.inject({ method: "POST", url: "/api/reservations", headers, payload: { ...payload, ...extra } });
    const response = await create(); assert.equal(response.statusCode, 201, response.body);
    const reservationId = response.json().id;
    const row = await prisma.emailOutbox.findUniqueOrThrow({ where: { eventKey: `reservation.created:${reservationId}` } });
    assert.equal(row.recipientEmail, "saved-admin@example.test"); assert.equal(row.tenantId, tenantId); assert.equal(row.salonId, salon.id);
    assert.deepEqual(row.payload, { reservationId, salonName: salon.name, tenantSlug: tenant.slug,
      startsAt: "2035-01-10T01:00:00.000Z", endsAt: "2035-01-10T01:30:00.000Z", durationMinutes: 30,
      customerName: customer.name, serviceName: service.name, reservationAmountYen: 2200, staffName: staff.name,
      isRequest: true, source: "PHONE", status: "CONFIRMED", paymentStatus: "UNPAID" });
    const serialized = JSON.stringify(row.payload);
    for (const excluded of [customer.phone!, "080-0000-0000", customer.memo!, payload.memo, payload.customerName, payload.serviceName]) assert(!serialized.includes(excluded), excluded);
    await prisma.customer.update({ where: { id: customer.id }, data: { name: "変更後の顧客名" } });
    await prisma.service.update({ where: { id: service.id }, data: { price: 9999, name: "変更後メニュー" } });
    assert.deepEqual((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })).payload, row.payload);

    const count = await prisma.emailOutbox.count({ where: scope });
    const conflict = await create(); assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(await prisma.emailOutbox.count({ where: scope }), count);
    const cancelled = await create({ status: "CANCELLED" }); assert.equal(cancelled.statusCode, 201, cancelled.body);
    assert.equal(await prisma.emailOutbox.count({ where: { eventKey: `reservation.created:${cancelled.json().id}` } }), 0);
    await prisma.salonSettings.update({ where: { tenantId_salonId: scope }, data: { notifyReservationEmail: false } });
    const disabled = await create({ startTime: "11:00" }); assert.equal(disabled.statusCode, 201, disabled.body);
    assert.equal(await prisma.emailOutbox.count({ where: { eventKey: `reservation.created:${disabled.json().id}` } }), 0);
  } finally {
    await server.close(); auth.mock.restore();
    if (tenantId) { await prisma.emailOutbox.deleteMany({ where: { tenantId } }); await prisma.tenant.delete({ where: { id: tenantId } }); }
    if (userId) await prisma.appUser.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }
});
