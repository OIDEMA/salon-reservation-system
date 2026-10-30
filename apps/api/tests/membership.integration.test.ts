import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("membership API keeps tenant-owned cards, balances and staff reception separate", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use an explicit disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl!; process.env.API_DISABLE_LISTEN = "1";
  const prefix = `membership-${randomUUID().slice(0, 8)}`;
  process.env.MEMBER_BOOKING_TENANTS = `${prefix}-first:antiage`;
  const [{ prisma }, { firebaseAdminAuth }, { server }] = await Promise.all([import("../src/database.js"), import("../src/auth.js"), import("../src/server.js")]);
  server.log.level = "silent";
  const tenants: string[] = [], users: string[] = [], programs: string[] = [];
  const memberA = `${prefix}-member-a`, memberB = `${prefix}-member-b`, ownerUid = `${prefix}-owner`, cashierUid = `${prefix}-cashier`;
  const token = (uid: string) => `${Buffer.from("header").toString("base64url")}.${Buffer.from(uid).toString("base64url")}.signature`;
  const identities = new Map([memberA, memberB, ownerUid, cashierUid].map((uid) => [token(uid), {
    uid, aud: "salon-reserve-bg", iss: "https://securetoken.google.com/salon-reserve-bg", email: `${uid}@example.test`, email_verified: true,
    firebase: { sign_in_provider: "password", identities: {} },
  }]));
  t.mock.method(firebaseAdminAuth, "verifyIdToken", async (credential: string, revoked?: boolean) => { assert.equal(revoked, true); const claims = identities.get(credential); if (!claims) throw new Error("invalid credential"); return claims as any; });
  t.mock.method(firebaseAdminAuth, "verifySessionCookie", async (credential: string) => { const claims = identities.get(credential); if (!claims) throw new Error("invalid credential"); return claims as any; });
  const memberHeaders = (uid = memberA) => ({ authorization: `Bearer ${token(uid)}` });
  try {
    const program = await prisma.membershipProgram.create({ data: { slug: prefix, name: "会員連携テスト" } }); programs.push(program.id);
    const unrelatedProgram = await prisma.membershipProgram.create({ data: { slug: `${prefix}-other`, name: "別企業" } }); programs.push(unrelatedProgram.id);
    async function fixture(name: string, programId: string | null, existingTenant?: { id: string; slug: string; name: string }) {
      const tenant = existingTenant ?? await prisma.tenant.create({ data: { slug: `${prefix}-${name}`, name, membershipProgramId: programId } });
      if (!existingTenant) tenants.push(tenant.id);
      const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: `${name}店舗` } });
      const customer = await prisma.customer.create({ data: { tenantId: tenant.id, salonId: salon.id, name: "既存顧客", kana: "キソン", phone: "09000000000", memo: "private chart contents" } });
      const service = await prisma.service.create({ data: { tenantId: tenant.id, salonId: salon.id, name: "確認施術", category: "test", price: 9800, durationMinutes: 60, color: "#111111" } });
      const reservation = await prisma.reservation.create({ data: { tenantId: tenant.id, salonId: salon.id, customerId: customer.id, serviceId: service.id,
        startsAt: new Date("2026-10-29T01:00:00Z"), endsAt: new Date("2026-10-29T02:00:00Z"), status: "COMPLETED" } });
      return { tenant, salon, customer, reservation };
    }
    const a = await fixture("first", program.id);
    const b = await fixture("second", program.id, a.tenant), other = await fixture("unrelated", unrelatedProgram.id), disabled = await fixture("unconfigured", null);
    const owner = await prisma.appUser.create({ data: { firebaseUid: ownerUid, email: `${ownerUid}@example.test` } }); users.push(owner.id);
    for (const row of [a, disabled]) await prisma.tenantMembership.create({ data: { userId: owner.id, tenantId: row.tenant.id, role: "OWNER" } });
    const cashier = await prisma.appUser.create({ data: { firebaseUid: cashierUid, email: `${cashierUid}@example.test` } }); users.push(cashier.id);
    await prisma.tenantMembership.create({ data: { userId: cashier.id, tenantId: a.tenant.id, role: "STAFF", useCustomPermissions: true,
      permissions: ["checkout.read", "checkout.write"], salonIds: [a.salon.id] } });
    const staffHeaders = (row = a, uid = ownerUid) => ({ ...memberHeaders(uid), "x-tenant-slug": row.tenant.slug, "x-salon-id": row.salon.id });
    const call = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = staffHeaders()) => server.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    const enroll = (uid = memberA, programId = program.id, extras = {}) => call("POST", "/api/member/membership", { programId, displayName: "確認用会員", ...extras }, memberHeaders(uid));
    const own = (uid = memberA, programId = program.id) => call("GET", `/api/member/membership?programId=${programId}`, undefined, memberHeaders(uid));
    let account: { id: string; number: string; name: string }, secondAccount: { id: string; number: string };

    await t.test("enrollment derives identity and numbers from trusted sources", async () => {
      assert.equal((await call("POST", "/api/member/membership", { programId: program.id, displayName: "会員" }, {})).statusCode, 401);
      assert.equal((await own()).statusCode, 404);
      for (const field of ["uid", "projectId", "memberNumber", "balance"]) assert.equal((await enroll(memberA, program.id, { [field]: "forged" })).statusCode, 400);
      const first = await enroll(); assert.equal(first.statusCode, 201, first.body); account = first.json().member;
      assert.match(account.number, /^\d{13}$/); assert.equal(first.json().balance, 0); assert.equal(first.json().availablePoints, 0);
      const repeat = await enroll(memberA, program.id, { displayName: "上書きしない" }); assert.equal(repeat.statusCode, 200, repeat.body);
      assert.equal(repeat.json().member.id, account.id); assert.equal(repeat.json().member.number, account.number); assert.equal(repeat.json().member.name, account.name);
      assert.equal((await own(memberB)).statusCode, 404);
      const another = await enroll(memberB); assert.equal(another.statusCode, 201, another.body); secondAccount = another.json().member;
      assert.notEqual(secondAccount.number, account.number);
      const listed = await call("GET", "/api/member/membership/programs", undefined, memberHeaders());
      assert.equal(listed.statusCode, 200); assert(Array.isArray(listed.json()));
      assert(listed.json().some((entry: any) => entry.id === program.id));
      const publicProgram = listed.json().find((entry: any) => entry.id === program.id);
      assert.equal(publicProgram.enrolled, true); assert.equal(publicProgram.canEnroll, true);
      assert.deepEqual(publicProgram.brands, ["antiage"]);
      assert.equal(publicProgram.publicTenants.length, 1);
      assert(!listed.json().some((entry: any) => entry.id === unrelatedProgram.id));
      assert(!listed.body.includes("uid")); assert(!listed.body.includes(account.number));
      assert.equal((await own()).headers["cache-control"], "private, no-store");
    });

    await t.test("staff scope and program membership cannot be selected by a barcode", async () => {
      const input = { barcode: account.number, reservationId: a.reservation.id };
      assert.equal((await call("POST", "/api/membership/lookup", input, {})).statusCode, 401);
      assert.equal((await call("POST", "/api/membership/lookup", input, memberHeaders())).statusCode, 400);
      assert.equal((await call("POST", "/api/membership/lookup", input, staffHeaders(other))).statusCode, 403);
      assert.equal((await call("POST", "/api/membership/lookup", { barcode: account.number }, staffHeaders(disabled))).statusCode, 503);
      assert.equal((await call("POST", "/api/membership/lookup", { barcode: "https://outside.example/1000000000001" })).statusCode, 400);
      assert.equal((await call("POST", "/api/membership/lookup", { barcode: account.number, reservationId: other.reservation.id })).statusCode, 404);
      assert.equal((await enroll(memberA, unrelatedProgram.id)).statusCode, 503);
      const unrelated = await prisma.membershipAccount.create({ data: { programId: unrelatedProgram.id, projectId: "salon-reserve-bg", uid: memberA, displayName: "過去の会員" } });
      assert.equal((await call("POST", "/api/membership/lookup", { barcode: unrelated.memberNumber })).statusCode, 404);
      const response = await call("POST", "/api/membership/lookup", input); assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().linkStatus, "UNLINKED"); assert.equal(response.json().customerId, a.customer.id);
      assert.equal(response.json().policy.redemptionUnit, 100); assert.equal(response.json().policy.pointValueYen, 1);
      for (const value of [a.customer.phone!, a.customer.memo!, "projectId", "uid"]) assert(!response.body.includes(value));
      assert.equal(response.headers["cache-control"], "private, no-store");
    });

    await t.test("discovery hides private companies while retaining only the owner's old program history", async () => {
      const owned = await call("GET", "/api/member/membership/programs", undefined, memberHeaders(memberA));
      const historical = owned.json().find((entry: any) => entry.id === unrelatedProgram.id);
      assert(historical); assert.equal(historical.enrolled, true); assert.equal(historical.canEnroll, false);
      assert.deepEqual(historical.publicTenants, []); assert.deepEqual(historical.brands, []);
      const stranger = await call("GET", "/api/member/membership/programs", undefined, memberHeaders(memberB));
      assert(!stranger.json().some((entry: any) => entry.id === unrelatedProgram.id));
      const prior = await own(memberA, unrelatedProgram.id); assert.equal(prior.statusCode, 200, prior.body); assert.equal(prior.json().member.active, false);
      const publication = process.env.MEMBER_BOOKING_TENANTS;
      process.env.MEMBER_BOOKING_TENANTS = "";
      try {
        const existing = await own(); assert.equal(existing.json().member.active, false); assert.equal(existing.json().availablePoints, 0);
        const list = await call("GET", "/api/member/membership/programs", undefined, memberHeaders());
        const current = list.json().find((entry: any) => entry.id === program.id);
        assert(current?.enrolled); assert.equal(current.canEnroll, false); assert.deepEqual(current.publicTenants, []);
        assert.equal((await enroll()).statusCode, 503);
      } finally { process.env.MEMBER_BOOKING_TENANTS = publication; }
    });

    await t.test("customer linking requires confirmation and grants no reservation ownership", async () => {
      const url = `/api/admin/customers/${a.customer.id}/membership-link`;
      const input = { barcode: account.number, expectedMemberId: account.id, confirmed: true };
      assert.equal((await call("POST", url, { ...input, confirmed: false })).statusCode, 400);
      assert.equal((await call("POST", url, { ...input, expectedMemberId: randomUUID() })).statusCode, 409);
      assert.equal((await call("POST", url, input, staffHeaders(a, cashierUid))).statusCode, 403);
      const beforeBookingLinks = await prisma.memberCustomerLink.count({ where: { tenantId: a.tenant.id } });
      for (let retry = 0; retry < 2; retry++) {
        const linked = await call("POST", url, input); assert.equal(linked.statusCode, 200, linked.body); assert.equal(linked.json().linkStatus, "LINKED");
      }
      assert.equal(await prisma.membershipCustomerLink.count({ where: { accountId: account.id, tenantId: a.tenant.id } }), 1);
      assert.equal(await prisma.memberCustomerLink.count({ where: { tenantId: a.tenant.id } }), beforeBookingLinks);
      assert.equal((await call("POST", url, { ...input, barcode: secondAccount.number, expectedMemberId: secondAccount.id })).statusCode, 409);
      const secondCustomer = await prisma.customer.create({ data: { tenantId: a.tenant.id, salonId: a.salon.id, name: "別のお客様", kana: "ベツ" } });
      assert.equal((await call("POST", `/api/admin/customers/${secondCustomer.id}/membership-link`, input)).statusCode, 409);
      const mismatch = await call("POST", "/api/membership/lookup", { barcode: secondAccount.number, reservationId: a.reservation.id });
      assert.equal(mismatch.statusCode, 200, mismatch.body); assert.equal(mismatch.json().linkStatus, "MISMATCH");
      const existing = await call("GET", `/api/admin/customers/${a.customer.id}/membership`); assert.equal(existing.statusCode, 200, existing.body); assert.equal(existing.json().member.id, account.id);
    });

    await t.test("cash-only staff can receive the checkout customer without broad customer access", async () => {
      const created = await call("POST", "/api/cash/checkouts", { reservationId: a.reservation.id, requestId: randomUUID() }); assert.equal(created.statusCode, 201, created.body);
      const cashierHeaders = staffHeaders(a, cashierUid);
      assert.equal((await call("POST", "/api/membership/lookup", { barcode: account.number }, cashierHeaders)).statusCode, 403);
      const scoped = await call("POST", "/api/membership/lookup", { barcode: account.number, checkoutId: created.json().id }, cashierHeaders);
      assert.equal(scoped.statusCode, 200, scoped.body); assert.equal(scoped.json().linkStatus, "LINKED");
      assert.equal((await call("POST", "/api/membership/lookup", { barcode: account.number, checkoutId: randomUUID() }, cashierHeaders)).statusCode, 404);
    });

    await t.test("one tenant's salons share a balance while staff history stays within its store", async () => {
      for (const [row, amount] of [[a, 100], [b, 300]] as const) await prisma.membershipPointEntry.create({ data: { programId: program.id, accountId: account.id,
        tenantId: row.tenant.id, salonId: row.salon.id, kind: "EARN", delta: amount, requestId: randomUUID(), createdByUserId: owner.id } });
      const lookup = await call("POST", "/api/membership/lookup", { barcode: account.number }); assert.equal(lookup.statusCode, 200, lookup.body);
      assert.equal(lookup.json().member.balance, 400); assert.equal(lookup.json().member.availablePoints, 400);
      assert.equal(lookup.json().history.length, 1); assert.equal(lookup.json().history[0].salonName, a.salon.name); assert(!lookup.body.includes(b.salon.name));
      const customer = await own(); assert.equal(customer.statusCode, 200, customer.body); assert.equal(customer.json().balance, 400);
      assert.equal(customer.json().transactions.length, 2); assert.equal(customer.json().qualifyingPoints, 400);
      assert.equal((await own(memberB)).json().balance, 0);
      const audit = await prisma.auditLog.findMany({ where: { tenantId: a.tenant.id, action: { startsWith: "membership." } } });
      const serialized = JSON.stringify(audit.map((entry) => entry.metadata));
      assert(!serialized.includes(account.number)); assert(!serialized.includes(a.customer.phone!));
    });

    await t.test("the same Firebase member gets independent cards and balances in different tenants", async () => {
      await prisma.tenantMembership.create({ data: { userId: owner.id, tenantId: other.tenant.id, role: "OWNER" } });
      process.env.MEMBER_BOOKING_TENANTS += `;${other.tenant.slug}:missmrs`;
      const otherEnrollment = await enroll(memberA, unrelatedProgram.id); assert.equal(otherEnrollment.statusCode, 200, otherEnrollment.body);
      const otherAccount = otherEnrollment.json().member;
      assert.notEqual(otherAccount.id, account.id); assert.notEqual(otherAccount.number, account.number);
      assert.equal(otherEnrollment.json().program.enrolled, true); assert.equal(otherEnrollment.json().program.canEnroll, true);
      assert.equal(otherEnrollment.json().program.publicTenants.length, 1);
      await prisma.membershipPointEntry.create({ data: { programId: unrelatedProgram.id, accountId: otherAccount.id, tenantId: other.tenant.id,
        salonId: other.salon.id, kind: "EARN", delta: 700, requestId: randomUUID(), createdByUserId: owner.id } });
      assert.equal((await own()).json().balance, 400); assert.equal((await own(memberA, unrelatedProgram.id)).json().balance, 700);
      assert.equal((await call("POST", "/api/membership/lookup", { barcode: account.number }, staffHeaders(other))).statusCode, 404);
      assert.equal((await call("POST", "/api/membership/lookup", { barcode: otherAccount.number })).statusCode, 404);
      const foreignLink = await call("POST", `/api/admin/customers/${other.customer.id}/membership-link`,
        { barcode: account.number, expectedMemberId: account.id, confirmed: true }, staffHeaders(other));
      assert.equal(foreignLink.statusCode, 409, foreignLink.body);
      await assert.rejects(prisma.membershipCustomerLink.create({ data: { programId: program.id, accountId: account.id,
        tenantId: other.tenant.id, salonId: other.salon.id, customerId: other.customer.id, linkedByUserId: owner.id } }));
      await assert.rejects(prisma.membershipPointEntry.create({ data: { programId: program.id, accountId: account.id,
        tenantId: other.tenant.id, salonId: other.salon.id, kind: "EARN", delta: 999, requestId: randomUUID(), createdByUserId: owner.id } }));
      await assert.rejects(prisma.tenant.update({ where: { id: other.tenant.id }, data: { membershipProgramId: program.id } }));
      await assert.rejects(prisma.tenant.update({ where: { id: a.tenant.id }, data: { membershipProgramId: null } }));
      await assert.rejects(prisma.tenant.create({ data: { slug: `${prefix}-shared-forbidden`, name: "共有は禁止", membershipProgramId: program.id } }));
      const firstLookup = await call("POST", "/api/membership/lookup", { barcode: account.number });
      const secondLookup = await call("POST", "/api/membership/lookup", { barcode: otherAccount.number }, staffHeaders(other));
      assert.equal(firstLookup.json().member.balance, 400); assert.equal(secondLookup.json().member.balance, 700);
      assert(!firstLookup.body.includes(other.salon.name)); assert(!secondLookup.body.includes(a.salon.name));
    });

    await t.test("checkout references cannot be assigned an account, tenant or salon from another company", async () => {
      const checkout = await prisma.cashCheckout.findFirstOrThrow({ where: { tenantId: a.tenant.id, reservationId: a.reservation.id } });
      const foreignAccount = await prisma.membershipAccount.findUniqueOrThrow({ where: { programId_projectId_uid: { programId: unrelatedProgram.id, projectId: "salon-reserve-bg", uid: memberA } } });
      await prisma.cashCheckout.update({ where: { id: checkout.id }, data: { membershipAccountId: account.id } });
      try {
        await assert.rejects(prisma.cashCheckout.update({ where: { id: checkout.id }, data: { membershipAccountId: foreignAccount.id } }));
        await assert.rejects(prisma.cashCheckout.update({ where: { id: checkout.id }, data: { tenantId: other.tenant.id, salonId: other.salon.id, reservationId: other.reservation.id } }));
        await assert.rejects(prisma.cashCheckout.update({ where: { id: checkout.id }, data: { salonId: other.salon.id } }));
        const unchanged = await prisma.cashCheckout.findUniqueOrThrow({ where: { id: checkout.id } });
        assert.equal(unchanged.tenantId, a.tenant.id); assert.equal(unchanged.salonId, a.salon.id); assert.equal(unchanged.membershipAccountId, account.id);
        // Stopping an account/program must not prevent an existing checkout's
        // same-tenant updates and refunds.
        await prisma.membershipAccount.update({ where: { id: account.id }, data: { active: false } });
        await prisma.membershipProgram.update({ where: { id: program.id }, data: { active: false } });
        await prisma.cashCheckout.update({ where: { id: checkout.id }, data: { pointsAwarded: 0 } });
      } finally {
        await prisma.membershipAccount.update({ where: { id: account.id }, data: { active: true } });
        await prisma.membershipProgram.update({ where: { id: program.id }, data: { active: true } });
        await prisma.cashCheckout.update({ where: { id: checkout.id }, data: { membershipAccountId: checkout.membershipAccountId } });
      }
    });

    await t.test("first enrollment locks its tenant until a concurrent detach sees the committed account", async () => {
      const raceProgram = await prisma.membershipProgram.create({ data: { slug: `${prefix}-race`, name: "入会・切離競合" } }); programs.push(raceProgram.id);
      const raceTenant = await prisma.tenant.create({ data: { slug: `${prefix}-race`, name: "競合確認", membershipProgramId: raceProgram.id } }); tenants.push(raceTenant.id);
      let ready!: (pid: number) => void, release!: () => void;
      const inserting = new Promise<number>((resolve) => { ready = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const enrollment = prisma.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        const account = await tx.membershipAccount.create({ data: { programId: raceProgram.id, projectId: "salon-reserve-bg", uid: memberA, displayName: "最初の会員" } });
        ready(pid); await held; return account;
      }, { timeout: 10000, isolationLevel: "ReadCommitted" });
      const pid = await Promise.race([inserting, enrollment.then(() => { throw new Error("Enrollment finished before its lock was observed"); })]);
      const detaching = prisma.tenant.update({ where: { id: raceTenant.id }, data: { membershipProgramId: null } })
        .then(() => ({ success: true }), () => ({ success: false }));
      let blocked = false;
      try {
        const deadline = Date.now() + 1500;
        do {
          const [wait] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE ${pid} = ANY(pg_blocking_pids(a.pid))) AS blocked`;
          blocked = wait.blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        } while (!blocked && Date.now() < deadline);
      } finally { release(); await Promise.all([enrollment, detaching]); }
      assert(blocked, "Tenant detach must wait for the in-flight first account insert");
      const account = await enrollment; assert.match(account.memberNumber, /^\d{13}$/);
      assert.equal((await detaching).success, false);
      assert.equal((await prisma.tenant.findUniqueOrThrow({ where: { id: raceTenant.id } })).membershipProgramId, raceProgram.id);
    });

    await t.test("numbering and immutable history cannot be bypassed through model writes", async () => {
      const supplied = await prisma.membershipAccount.create({ data: { programId: program.id, projectId: "salon-reserve-bg", uid: `${prefix}-explicit`, displayName: "採番テスト", memberNumber: "9999999999999" } });
      assert.match(supplied.memberNumber, /^\d{13}$/); assert.notEqual(supplied.memberNumber, "9999999999999");
      await assert.rejects(prisma.membershipAccount.update({ where: { id: supplied.id }, data: { memberNumber: "9999999999998" } }));
      const entry = await prisma.membershipPointEntry.findFirstOrThrow({ where: { accountId: account.id } });
      await assert.rejects(prisma.membershipPointEntry.update({ where: { id: entry.id }, data: { delta: 9999 } }));
      await assert.rejects(prisma.membershipPointEntry.delete({ where: { id: entry.id } }));
      await assert.rejects(prisma.membershipPointEntry.create({ data: { programId: program.id, accountId: account.id, tenantId: other.tenant.id,
        salonId: other.salon.id, kind: "EARN", delta: 1, requestId: randomUUID(), createdByUserId: owner.id } }));
      await assert.rejects(prisma.membershipPointEntry.create({ data: { programId: program.id, accountId: account.id, tenantId: a.tenant.id,
        salonId: a.salon.id, kind: "REDEEM", delta: -1, requestId: randomUUID(), createdByUserId: owner.id } }));
      const orphan = await prisma.membershipProgram.create({ data: { slug: `${prefix}-orphan`, name: "未所属program" } }); programs.push(orphan.id);
      await assert.rejects(prisma.membershipAccount.create({ data: { programId: orphan.id, projectId: "salon-reserve-bg", uid: memberA, displayName: "所属なし発行は禁止" } }));
      assert.equal((await own()).json().balance, 400);
    });

    await t.test("returned spend is not new rank earnings and spent awards can become non-spendable debt", async () => {
      const original = await prisma.membershipPointEntry.findFirstOrThrow({ where: { accountId: account.id, tenantId: a.tenant.id, kind: "EARN" } });
      const redeemed = await prisma.membershipPointEntry.create({ data: { programId: program.id, accountId: account.id, tenantId: a.tenant.id, salonId: a.salon.id,
        kind: "REDEEM", delta: -100, requestId: randomUUID(), createdByUserId: owner.id } });
      await prisma.membershipPointEntry.create({ data: { programId: program.id, accountId: account.id, tenantId: a.tenant.id, salonId: a.salon.id,
        kind: "REFUND", delta: 100, reversalOfId: redeemed.id, requestId: randomUUID(), createdByUserId: owner.id } });
      await prisma.membershipPointEntry.create({ data: { programId: program.id, accountId: account.id, tenantId: a.tenant.id, salonId: a.salon.id,
        kind: "EARN_REVERSAL", delta: -100, reversalOfId: original.id, requestId: randomUUID(), createdByUserId: owner.id } });
      const ranked = await own(); assert.equal(ranked.json().balance, 300); assert.equal(ranked.json().qualifyingPoints, 300);
      const earned = await prisma.membershipPointEntry.create({ data: { programId: program.id, accountId: secondAccount.id, tenantId: a.tenant.id, salonId: a.salon.id,
        kind: "EARN", delta: 100, requestId: randomUUID(), createdByUserId: owner.id } });
      await prisma.membershipPointEntry.create({ data: { programId: program.id, accountId: secondAccount.id, tenantId: a.tenant.id, salonId: a.salon.id,
        kind: "REDEEM", delta: -100, requestId: randomUUID(), createdByUserId: owner.id } });
      await prisma.membershipPointEntry.create({ data: { programId: program.id, accountId: secondAccount.id, tenantId: a.tenant.id, salonId: a.salon.id,
        kind: "EARN_REVERSAL", delta: -100, reversalOfId: earned.id, requestId: randomUUID(), createdByUserId: owner.id } });
      const debt = await own(memberB); assert.equal(debt.json().balance, -100); assert.equal(debt.json().availablePoints, 0); assert.equal(debt.json().qualifyingPoints, 0);
    });

    await t.test("stopped accounts and programs retain only the owner's history and hide the usable card", async () => {
      await prisma.membershipAccount.update({ where: { id: account.id }, data: { active: false } });
      const inactive = await own(); assert.equal(inactive.statusCode, 200, inactive.body); assert.equal(inactive.json().member.active, false); assert.equal(inactive.json().balance, 300);
      assert.equal(inactive.json().program.enrolled, true); assert.equal(inactive.json().program.canEnroll, false);
      assert.equal(inactive.json().availablePoints, 0);
      assert.equal((await call("POST", "/api/membership/lookup", { barcode: account.number })).statusCode, 404);
      await prisma.membershipAccount.update({ where: { id: account.id }, data: { active: true } });
      await prisma.membershipProgram.update({ where: { id: program.id }, data: { active: false } });
      const stopped = await own(); assert.equal(stopped.statusCode, 200, stopped.body); assert.equal(stopped.json().member.active, false); assert.equal(stopped.json().balance, 300);
      assert.equal(stopped.json().program.enrolled, true); assert.equal(stopped.json().program.canEnroll, false);
      assert.equal(stopped.json().availablePoints, 0);
      assert.equal((await call("POST", "/api/membership/lookup", { barcode: account.number })).statusCode, 503);
      assert.equal((await enroll()).statusCode, 503);
      await prisma.membershipProgram.update({ where: { id: program.id }, data: { active: true } });
      assert.equal((await own()).json().member.active, true);
    });

    await t.test("history is bounded, while totals remain complete and enumeration attempts are limited", async () => {
      await prisma.membershipPointEntry.createMany({ data: Array.from({ length: 52 }, () => ({ programId: program.id, accountId: account.id,
        tenantId: a.tenant.id, salonId: a.salon.id, kind: "EARN" as const, delta: 1, requestId: randomUUID(), createdByUserId: owner.id })) });
      const result = await own(); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().balance, 352);
      assert.equal(result.json().transactions.length, 50); assert.equal(result.json().historyComplete, false);
      const currentWindow = new Date(Math.floor(Date.now() / 600_000) * 600_000);
      await prisma.membershipLookupRateLimit.upsert({ where: { actorKey_programId_windowStartsAt: { actorKey: `staff:${owner.id}`, programId: program.id, windowStartsAt: currentWindow } },
        create: { actorKey: `staff:${owner.id}`, programId: program.id, windowStartsAt: currentWindow, attempts: 120 }, update: { attempts: 120 } });
      const limited = await call("POST", "/api/membership/lookup", { barcode: account.number }); assert.equal(limited.statusCode, 429, limited.body);
      assert(!limited.body.includes(account.number));
    });
  } finally {
    // Only this suite's local fixtures are removed. A table lock keeps concurrent
    // tests from observing the brief trigger disable inside this transaction.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "MembershipPointEntry" DISABLE TRIGGER USER');
      await tx.membershipPointEntry.deleteMany({ where: { programId: { in: programs } } });
      await tx.$executeRawUnsafe('ALTER TABLE "MembershipPointEntry" ENABLE TRIGGER USER');
      await tx.membershipCustomerLink.deleteMany({ where: { programId: { in: programs } } });
      await tx.cashCheckoutItem.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.cashPaymentAllocation.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.cashCheckout.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.membershipAccount.deleteMany({ where: { programId: { in: programs } } });
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
      await tx.appUser.deleteMany({ where: { OR: [{ id: { in: users } }, { firebaseUid: { startsWith: prefix } }] } });
      await tx.membershipLookupRateLimit.deleteMany({ where: { programId: { in: programs } } });
      await tx.membershipProgram.deleteMany({ where: { id: { in: programs } } });
    });
    await server.close(); await prisma.$disconnect();
  }
});
