import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("admin placement mutations share transaction capacity checks", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl!;
  process.env.API_DISABLE_LISTEN = "1";
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([
    import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")
  ]);
  const prefix = `capacity-${randomUUID().slice(0, 8)}`;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const auth = t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => {
    assert.equal(credential, prefix);
    return { uid: prefix, email: `${prefix}@example.test`, email_verified: true, name: "Capacity test operator" };
  });
  try {
    const tenant = await prisma.tenant.create({ data: { slug: prefix, name: "Capacity test tenant" } }); tenantIds.push(tenant.id);
    const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: "Capacity test salon" } });
    const scope = { tenantId: tenant.id, salonId: salon.id };
    const user = await prisma.appUser.create({ data: { firebaseUid: prefix, email: `${prefix}@example.test` } }); userIds.push(user.id);
    await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: "OWNER" } });
    await prisma.salonSettings.create({ data: { ...scope, storeId: prefix, maxConcurrentReservations: 10, cancellationMessage: "cancelled", friendMessage: "welcome" } });
    const customer = await prisma.customer.create({ data: { ...scope, name: "Capacity test customer", kana: "テスト" } });
    const service = await prisma.service.create({ data: { ...scope, name: "Capacity test service", category: "Test", durationMinutes: 60, price: 1000, color: "#000000" } });
    const staff = await prisma.staff.create({ data: { ...scope, name: "Capacity test staff", kana: "テスト", role: "ESTHETICIAN", color: "#000000", parallelCapacity: 1 } });
    const headers = { authorization: `Bearer ${prefix}`, "x-tenant-slug": tenant.slug, "x-salon-id": salon.id };
    const payload = (date: string, startTime: string) => ({ date, startTime, durationMinutes: 60, customerId: customer.id, customerName: customer.name, serviceId: service.id, serviceName: service.name, staffId: staff.id, status: "CONFIRMED", source: "PHONE" });
    const create = (date: string, startTime: string) => server.inject({ method: "POST", url: "/api/reservations", headers, payload: payload(date, startTime) });
    const patch = (id: string, body: unknown) => server.inject({ method: "PATCH", url: `/api/reservations/${id}`, headers, payload: body });
    const status = (id: string, value: string) => server.inject({ method: "PATCH", url: `/api/reservations/${id}/status`, headers, payload: { status: value } });
    await t.test("simultaneous creations cannot exceed one staff slot", async () => {
      const results = await Promise.all([create("2035-01-01", "10:00"), create("2035-01-01", "10:00")]);
      assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409], results.map((result) => result.body).join("\n"));
      const failed = results.find((result) => result.statusCode === 409)!;
      assert.equal(failed.json().code, "STAFF_CONFLICT");
      assert.equal(await prisma.reservation.count({ where: { ...scope, startsAt: new Date("2035-01-01T10:00:00+09:00") } }), 1);
    });
    await t.test("concurrent moves into one free slot allow only one reservation", async () => {
      const first = await create("2035-01-02", "10:00"); const second = await create("2035-01-02", "11:00");
      assert.equal(first.statusCode, 201, first.body); assert.equal(second.statusCode, 201, second.body);
      const results = await Promise.all([patch(first.json().id, { startTime: "14:00" }), patch(second.json().id, { startTime: "14:00" })]);
      assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409], results.map((result) => result.body).join("\n"));
      assert.equal(await prisma.reservation.count({ where: { ...scope, startsAt: new Date("2035-01-02T14:00:00+09:00") } }), 1);
    });
    await t.test("cancelled restoration and fresh create compete for the same capacity", async () => {
      const existing = await create("2035-01-03", "10:00"); assert.equal(existing.statusCode, 201, existing.body);
      assert.equal((await status(existing.json().id, "CANCELLED")).statusCode, 200);
      const results = await Promise.all([status(existing.json().id, "CONFIRMED"), create("2035-01-03", "10:00")]);
      assert.equal(results.filter((result) => result.statusCode === 200 || result.statusCode === 201).length, 1, results.map((result) => result.body).join("\n"));
      assert.equal(results.filter((result) => result.statusCode === 409).length, 1);
      assert.equal(await prisma.reservation.count({ where: { ...scope, status: { in: ["PENDING", "CONFIRMED", "ARRIVED", "COMPLETED"] }, startsAt: new Date("2035-01-03T10:00:00+09:00") } }), 1);
    });
    await t.test("completed reservations retain capacity while editing self and adjacent bookings remain valid", async () => {
      const existing = await create("2035-01-04", "10:00"); assert.equal(existing.statusCode, 201, existing.body);
      assert.equal((await patch(existing.json().id, { memo: "same placement" })).statusCode, 200);
      const completed = await status(existing.json().id, "COMPLETED"); assert.equal(completed.statusCode, 200, completed.body);
      const denied = await create("2035-01-04", "10:30"); assert.equal(denied.statusCode, 409, denied.body); assert.equal(denied.json().code, "STAFF_CONFLICT");
      const adjacent = await create("2035-01-04", "11:00"); assert.equal(adjacent.statusCode, 201, adjacent.body);
    });
    await t.test("salon capacity applies across different staff", async () => {
      await prisma.salonSettings.update({ where: { tenantId_salonId: scope }, data: { maxConcurrentReservations: 1 } });
      const secondStaff = await prisma.staff.create({ data: { ...scope, name: "Second test staff", kana: "テスト", role: "ESTHETICIAN", color: "#000000" } });
      const results = await Promise.all([
        create("2035-01-05", "10:00"),
        server.inject({ method: "POST", url: "/api/reservations", headers, payload: { ...payload("2035-01-05", "10:00"), staffId: secondStaff.id } })
      ]);
      assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409], results.map((result) => result.body).join("\n"));
      assert.equal(results.find((result) => result.statusCode === 409)!.json().code, "SALON_CAPACITY_EXCEEDED");
    });
  } finally {
    await server.close(); auth.mock.restore();
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
