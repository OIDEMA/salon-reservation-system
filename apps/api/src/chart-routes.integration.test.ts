import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import sharp from "sharp";
import type { OperationContext } from "./operations-support.js";
import type { ChartPhotoObject, ChartPhotoStorage } from "./chart-photo-storage.js";
import { ChartError } from "./chart-domain.js";

type TestChart = {
  id: string; version: number; status: string; currentRevisionNumber: number; customerId: string; customerName: string;
  revisions: Array<{ revisionNumber: number; status: string; performedServiceDetail: string; amendmentReason: string | null; photos: Array<{ id: string; phase: string; bodyPart: string | null; note: string | null; capturedAt: string | null }> }>;
};

// This test never targets a configured production database. Run explicitly against a disposable local DB.
const testDatabaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
test("persisted chart lifecycle, scoped photographs and concurrent amendment protection", { skip: !testDatabaseUrl }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && target.pathname.endsWith("_test"), "Use a disposable local *_test database");
  process.env.DATABASE_URL = testDatabaseUrl;
  const { prisma } = await import("./database.js");
  const { registerChartRoutes } = await import("./chart-routes.js");
  const prefix = `chart-test-${randomUUID().slice(0, 12)}`;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const server = Fastify();
  const stored = new Map<string, { data: Buffer; object: ChartPhotoObject }>();
  let failWrite = false;
  let failRead = false;
  let failRemove = false;
  let putCount = 0;
  let afterPut: (() => Promise<void>) | null = null;
  const storage: ChartPhotoStorage = {
    async put(input) {
      putCount++;
      if (failWrite) throw new ChartError("CHART_PHOTO_STORAGE_UNAVAILABLE", "保存先に接続できません。", 503);
      const object = { storageBucket: "private-test-photos", storagePath: `chart-photos/${input.tenantId}/${input.salonId}/${input.chartId}/${input.photoId}`, storageGeneration: String(putCount) };
      stored.set(object.storagePath, { data: Buffer.from(input.data), object });
      if (afterPut) { const callback = afterPut; afterPut = null; await callback(); }
      return object;
    },
    async read(object) {
      if (failRead) throw new ChartError("CHART_PHOTO_STORAGE_UNAVAILABLE", "保存先に接続できません。", 503);
      const record = stored.get(object.storagePath);
      assert.ok(record, "Object must exist in fake private storage");
      assert.deepEqual(object, record.object, "Read must request the persisted generation");
      return record.data;
    },
    async remove(object) {
      if (failRemove) throw new ChartError("CHART_PHOTO_STORAGE_UNAVAILABLE", "保存先に接続できません。", 503);
      const record = stored.get(object.storagePath);
      if (record) assert.deepEqual(object, record.object, "Delete must request the persisted generation");
      stored.delete(object.storagePath);
    }
  };
  try {
    const user = await prisma.appUser.create({ data: { firebaseUid: prefix, displayName: "カルテ検証スタッフ" } });
    userIds.push(user.id);
    async function createContext(suffix: string): Promise<OperationContext> {
      const tenant = await prisma.tenant.create({ data: { slug: `${prefix}-${suffix}`, name: `検証テナント ${suffix}` } });
      tenantIds.push(tenant.id);
      const membership = await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: "OWNER" } });
      const salon = await prisma.salon.create({ data: { tenantId: tenant.id, name: `検証店舗 ${suffix}` } });
      return { tenant, user, membership, salon };
    }
    const a = await createContext("a");
    const b = await createContext("b");
    const otherSalon = await prisma.salon.create({ data: { tenantId: a.tenant.id, name: "同テナントの別店舗" } });
    const otherA = { ...a, salon: otherSalon };
    const contexts: Record<string, OperationContext> = { a, b, otherA };
    await registerChartRoutes(server, { photoStorage: storage, requireContext: async (request, reply, permission) => {
      const context = contexts[String(request.headers["x-test-scope"] ?? "")];
      if (!context) { reply.code(401).send({ message: "認証が必要です。" }); return null; }
      if (request.headers["x-test-read-only"] === "true" && permission === "chart.write") {
        reply.code(403).send({ message: "この操作を行う権限がありません。" }); return null;
      }
      // Keep the request's initial authority snapshot stale when the DB changes.
      // Each mutation must obtain fresh authority through lockOperation itself.
      return { ...context, tenant: { ...context.tenant }, user: { ...context.user }, membership: { ...context.membership }, salon: { ...context.salon } };
    } });
    const customer = await prisma.customer.create({ data: { tenantId: a.tenant.id, salonId: a.salon.id, name: "検証顧客", kana: "ケンショウ" } });
    const staff = await prisma.staff.create({ data: { tenantId: a.tenant.id, salonId: a.salon.id, name: "担当A", kana: "タントウ", role: "STYLIST", color: "#18c7bd" } });
    const service = await prisma.service.create({ data: { tenantId: a.tenant.id, salonId: a.salon.id, name: "腕の施術", category: "施術", durationMinutes: 30, price: 3000, color: "#18c7bd" } });
    const reservation = await prisma.reservation.create({ data: {
      tenantId: a.tenant.id, salonId: a.salon.id, customerId: customer.id, staffId: staff.id, serviceId: service.id,
      startsAt: new Date("2026-10-13T02:00:00Z"), endsAt: new Date("2026-10-13T02:30:00Z")
    } });
    const content = { treatmentAt: "2026-10-13T02:00:00Z", bodyParts: ["腕"], performedServiceDetail: "", machine: "検証機器", outputJ: "10 J（記録値）", pulseWidth: "50 ms（記録値）", skinObservations: "PRIVATE OBSERVATION FOR TEST", productsMaterials: "材料A", aftercareNotes: "記録A", nextVisitPlan: "記録B" };
    const headers = { "x-test-scope": "a" };
    let chart: TestChart;
    const photo = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#cabdb3" } }).png().toBuffer();

    await t.test("authentication, read-only permissions, tenant and salon boundaries", async () => {
      assert.equal((await server.inject({ method: "GET", url: "/api/charts" })).statusCode, 401);
      assert.equal((await server.inject({ method: "POST", url: "/api/charts", headers: { ...headers, "x-test-read-only": "true" }, payload: { ...content, reservationId: reservation.id } })).statusCode, 403);
      for (const scope of ["b", "otherA"]) {
        assert.equal((await server.inject({ method: "POST", url: "/api/charts", headers: { "x-test-scope": scope }, payload: { ...content, reservationId: reservation.id } })).statusCode, 404);
        assert.equal((await server.inject({ method: "GET", url: `/api/charts/reservation-context/${reservation.id}`, headers: { "x-test-scope": scope } })).statusCode, 404);
      }
    });

    await t.test("draft creation is unique per reservation and empty content cannot finalize", async () => {
      const created = await server.inject({ method: "POST", url: "/api/charts", headers, payload: { ...content, reservationId: reservation.id } });
      assert.equal(created.statusCode, 201, created.body);
      chart = created.json<TestChart>();
      assert.equal(chart.version, 1);
      assert.equal(chart.customerId, customer.id);
      assert.equal(chart.status, "DRAFT");
      const duplicate = await server.inject({ method: "POST", url: "/api/charts", headers, payload: { ...content, reservationId: reservation.id } });
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.json<{ chartId: string }>().chartId, chart.id);
      assert.equal((await server.inject({ method: "POST", url: `/api/charts/${chart.id}/finalize`, headers, payload: { expectedVersion: 1 } })).statusCode, 400);
    });

    await t.test("simultaneous writes persist once and stale version fails", async () => {
      const outcomes = await Promise.all(["施術A", "施術B"].map((performedServiceDetail) => server.inject({
        method: "PATCH", url: `/api/charts/${chart.id}/draft`, headers, payload: { ...content, performedServiceDetail, expectedVersion: 1 }
      })));
      assert.deepEqual(outcomes.map((result) => result.statusCode).sort(), [200, 409]);
      chart = outcomes.find((result) => result.statusCode === 200)!.json<TestChart>();
      assert.equal(chart.version, 2);
      assert.equal((await prisma.treatmentChart.findFirstOrThrow({ where: { id: chart.id } })).version, 2);
      assert.equal((await server.inject({ method: "POST", url: `/api/charts/${chart.id}/finalize`, headers, payload: { expectedVersion: 1 } })).statusCode, 409);
    });

    await t.test("cloud failures, metadata, legacy reads and retryable draft deletion preserve records", async () => {
      const scratchReservation = await prisma.reservation.create({ data: {
        tenantId: a.tenant.id, salonId: a.salon.id, customerId: customer.id, staffId: staff.id, serviceId: service.id,
        startsAt: new Date("2026-10-16T02:00:00Z"), endsAt: new Date("2026-10-16T02:30:00Z")
      } });
      const created = await server.inject({ method: "POST", url: "/api/charts", headers, payload: { ...content, reservationId: scratchReservation.id, performedServiceDetail: "写真経過記録" } });
      assert.equal(created.statusCode, 201, created.body);
      let scratch = created.json<TestChart>();
      const upload = (metadata?: string) => server.inject({
        method: "POST", url: `/api/charts/${scratch.id}/photos?expectedVersion=${scratch.version}&phase=BEFORE`,
        headers: { ...headers, "content-type": "image/png", ...(metadata !== undefined ? { "x-chart-photo-metadata": metadata } : {}) }, payload: photo
      });
      failWrite = true;
      assert.equal((await upload()).statusCode, 503);
      failWrite = false;
      assert.equal((await prisma.treatmentChart.findUniqueOrThrow({ where: { id: scratch.id } })).version, scratch.version);
      assert.equal(await prisma.treatmentChartPhoto.count({ where: { chartId: scratch.id } }), 0);
      const beforeInvalid = putCount;
      for (const bad of ["not base64", Buffer.from(JSON.stringify({ note: "あ".repeat(1001) })).toString("base64"), Buffer.from(JSON.stringify({ capturedAt: "yesterday" })).toString("base64")]) {
        assert.equal((await upload(bad)).statusCode, 400);
      }
      assert.equal(putCount, beforeInvalid, "Invalid metadata must not upload bytes");
      const metadata = { bodyPart: "左腕", note: "脱毛経過の非公開メモ", capturedAt: "2026-10-13T11:15:00+09:00" };
      const saved = await upload(Buffer.from(JSON.stringify(metadata)).toString("base64"));
      assert.equal(saved.statusCode, 201, saved.body);
      scratch = saved.json<TestChart>();
      const savedPhoto = scratch.revisions[0].photos[0];
      assert.equal(savedPhoto.bodyPart, metadata.bodyPart);
      assert.equal(savedPhoto.note, metadata.note);
      assert.equal(savedPhoto.capturedAt, "2026-10-13T02:15:00.000Z");
      assert.equal(saved.body.includes("storagePath"), false);
      assert.equal(saved.body.includes("storageBucket"), false);
      assert.equal(saved.body.includes("storageGeneration"), false);
      const dbPhoto = await prisma.treatmentChartPhoto.findUniqueOrThrow({ where: { id: savedPhoto.id } });
      assert.equal(dbPhoto.data, null, "New cloud uploads must never duplicate bytes in PostgreSQL");
      assert.equal(dbPhoto.storageBucket, "private-test-photos");
      assert.equal(dbPhoto.note, metadata.note);
      assert.equal(JSON.stringify(await prisma.auditLog.findMany({ where: { tenantId: a.tenant.id } })).includes(metadata.note), false);
      failRead = true;
      assert.equal((await server.inject({ method: "GET", url: `/api/charts/${scratch.id}/photos/${savedPhoto.id}`, headers })).statusCode, 503);
      failRead = false;
      failRemove = true;
      const removed = await server.inject({ method: "DELETE", url: `/api/charts/${scratch.id}/photos/${savedPhoto.id}`, headers, payload: { expectedVersion: scratch.version } });
      assert.equal(removed.statusCode, 200, removed.body);
      scratch = removed.json<TestChart>();
      assert.equal(scratch.revisions[0].photos.length, 0);
      assert.equal((await server.inject({ method: "GET", url: `/api/charts/${scratch.id}/photos/${savedPhoto.id}`, headers })).statusCode, 404);
      const tombstone = await prisma.treatmentChartPhoto.findUniqueOrThrow({ where: { id: savedPhoto.id } });
      assert.ok(tombstone.storageDeletePendingAt);
      assert.ok(stored.has(dbPhoto.storagePath!));
      failRemove = false;
      const { cleanupUnreferencedChartPhotos } = await import("./chart-photo-cleanup.js");
      const cleanup = await cleanupUnreferencedChartPhotos({ tenantId: a.tenant.id, salonId: a.salon.id }, storage);
      assert.equal(cleanup.removed, 1);
      assert.equal(await prisma.treatmentChartPhoto.findUnique({ where: { id: savedPhoto.id } }), null);
      assert.equal(stored.has(dbPhoto.storagePath!), false);

      const revision = await prisma.treatmentChartRevision.findFirstOrThrow({ where: { chartId: scratch.id } });
      const legacy = await prisma.treatmentChartPhoto.create({ data: {
        tenantId: a.tenant.id, salonId: a.salon.id, chartId: scratch.id, phase: "BEFORE",
        mimeType: "image/png", width: 12, height: 8, byteSize: photo.length, data: photo
      } });
      await prisma.treatmentChartRevisionPhoto.create({ data: { tenantId: a.tenant.id, salonId: a.salon.id, chartId: scratch.id, revisionId: revision.id, photoId: legacy.id } });
      const legacyRead = await server.inject({ method: "GET", url: `/api/charts/${scratch.id}/photos/${legacy.id}`, headers });
      assert.equal(legacyRead.statusCode, 200);
      assert.deepEqual(legacyRead.rawPayload, photo);
      const legacyDeleted = await server.inject({ method: "DELETE", url: `/api/charts/${scratch.id}/photos/${legacy.id}`, headers, payload: { expectedVersion: scratch.version } });
      assert.equal(legacyDeleted.statusCode, 200, legacyDeleted.body);
      scratch = legacyDeleted.json<TestChart>();
      assert.equal(await prisma.treatmentChartPhoto.findUnique({ where: { id: legacy.id } }), null);

      const objectsBeforeConflict = stored.size;
      afterPut = async () => { await prisma.treatmentChart.update({ where: { id: scratch.id }, data: { version: { increment: 1 } } }); };
      const conflicted = await upload();
      assert.equal(conflicted.statusCode, 409, conflicted.body);
      assert.equal(stored.size, objectsBeforeConflict, "Definitely rolled back uploads are removed from storage");
      assert.equal(await prisma.treatmentChartPhoto.count({ where: { chartId: scratch.id } }), 0);

      scratch = (await server.inject({ method: "GET", url: `/api/charts/${scratch.id}`, headers })).json<TestChart>();
      const transactionHost = prisma as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> };
      const originalTransaction = transactionHost.$transaction;
      // Simulate a lost commit acknowledgement after the real DB transaction commits.
      transactionHost.$transaction = async (...args) => {
        await originalTransaction.apply(prisma, args);
        throw new Error("simulated lost commit acknowledgement");
      };
      try {
        const ambiguous = await upload();
        assert.equal(ambiguous.statusCode, 500, ambiguous.body);
      } finally {
        transactionHost.$transaction = originalTransaction;
      }
      const committed = await prisma.treatmentChartPhoto.findFirstOrThrow({ where: { chartId: scratch.id } });
      assert.ok(stored.has(committed.storagePath!), "An ambiguous outcome must never delete a committed photo");
      assert.equal(committed.storageDeletePendingAt, null);
      assert.equal((await server.inject({ method: "GET", url: `/api/charts/${scratch.id}/photos/${committed.id}`, headers })).statusCode, 200);
    });

    await t.test("photo cap, byte validation, private reads and safe list/audit data", async () => {
      for (let count = 0; count < 10; count++) {
        const uploaded = await server.inject({ method: "POST", url: `/api/charts/${chart.id}/photos?expectedVersion=${chart.version}&phase=BEFORE`, headers: { ...headers, "content-type": "image/png" }, payload: photo });
        assert.equal(uploaded.statusCode, 201, uploaded.body);
        chart = uploaded.json<TestChart>();
      }
      const exceeded = await server.inject({ method: "POST", url: `/api/charts/${chart.id}/photos?expectedVersion=${chart.version}&phase=AFTER`, headers: { ...headers, "content-type": "image/png" }, payload: photo });
      assert.equal(exceeded.statusCode, 400);
      assert.equal(chart.revisions[0].photos.length, 10);
      const cloudRows = await prisma.treatmentChartPhoto.findMany({ where: { chartId: chart.id } });
      assert.ok(cloudRows.every((row) => row.data === null && row.storageBucket && row.storagePath && row.storageGeneration));
      const photoId = chart.revisions[0].photos[0].id;
      const image = await server.inject({ method: "GET", url: `/api/charts/${chart.id}/photos/${photoId}`, headers });
      assert.equal(image.statusCode, 200);
      assert.equal(image.headers["content-type"], "image/png");
      assert.equal(image.headers["cache-control"], "private, no-store");
      assert.equal(image.headers["x-content-type-options"], "nosniff");
      assert.equal((await sharp(image.rawPayload).metadata()).width, 12);
      for (const scope of ["b", "otherA"]) {
        assert.equal((await server.inject({ method: "GET", url: `/api/charts/${chart.id}`, headers: { "x-test-scope": scope } })).statusCode, 404);
        assert.equal((await server.inject({ method: "GET", url: `/api/charts/${chart.id}/photos/${photoId}`, headers: { "x-test-scope": scope } })).statusCode, 404);
        assert.equal((await server.inject({ method: "PATCH", url: `/api/charts/${chart.id}/draft`, headers: { "x-test-scope": scope }, payload: { ...content, expectedVersion: chart.version } })).statusCode, 404);
      }
      const invalid = await server.inject({ method: "POST", url: `/api/charts/${chart.id}/photos?expectedVersion=${chart.version}&phase=BEFORE`, headers: { ...headers, "content-type": "image/png" }, payload: "not an image" });
      assert.equal(invalid.statusCode, 400);
      const list = await server.inject({ method: "GET", url: "/api/charts", headers });
      assert.equal(list.statusCode, 200);
      assert.equal(list.body.includes(content.skinObservations), false);
      assert.equal(list.body.includes('"data"'), false);
      const audit = await prisma.auditLog.findMany({ where: { tenantId: a.tenant.id } });
      assert.equal(JSON.stringify(audit).includes(content.skinObservations), false);
      assert.equal(JSON.stringify(audit).includes(photo.toString("base64")), false);
    });

    await t.test("finalized content is immutable and reasoned amendments preserve photos/history", async () => {
      const finalized = await server.inject({ method: "POST", url: `/api/charts/${chart.id}/finalize`, headers, payload: { expectedVersion: chart.version } });
      assert.equal(finalized.statusCode, 200, finalized.body);
      chart = finalized.json<TestChart>();
      assert.equal(chart.status, "FINALIZED");
      const originalVersion = chart.version;
      const photoId = chart.revisions[0].photos[0].id;
      assert.equal((await server.inject({ method: "PATCH", url: `/api/charts/${chart.id}/draft`, headers, payload: { ...content, expectedVersion: chart.version } })).statusCode, 409);
      assert.equal((await server.inject({ method: "DELETE", url: `/api/charts/${chart.id}/photos/${photoId}`, headers, payload: { expectedVersion: chart.version } })).statusCode, 409);
      assert.equal((await server.inject({ method: "POST", url: `/api/charts/${chart.id}/amend`, headers, payload: { expectedVersion: chart.version, reason: "  " } })).statusCode, 400);
      const amended = await server.inject({ method: "POST", url: `/api/charts/${chart.id}/amend`, headers, payload: { expectedVersion: chart.version, reason: "施術後の記録を追記" } });
      assert.equal(amended.statusCode, 200, amended.body);
      chart = amended.json<TestChart>();
      assert.equal(chart.currentRevisionNumber, 2);
      assert.equal(chart.revisions.length, 2);
      assert.equal(chart.revisions[0].amendmentReason, "施術後の記録を追記");
      assert.equal(chart.revisions[0].photos.length, 10);
      assert.equal((await server.inject({ method: "POST", url: `/api/charts/${chart.id}/amend`, headers, payload: { expectedVersion: originalVersion, reason: "別の訂正" } })).statusCode, 409);
      const removed = await server.inject({ method: "DELETE", url: `/api/charts/${chart.id}/photos/${photoId}`, headers, payload: { expectedVersion: chart.version } });
      assert.equal(removed.statusCode, 200);
      chart = removed.json<TestChart>();
      assert.equal(chart.revisions[0].photos.length, 9);
      assert.equal(chart.revisions[1].photos.length, 10);
      assert.equal((await server.inject({ method: "GET", url: `/api/charts/${chart.id}/photos/${photoId}`, headers })).statusCode, 200);
      const changed = await server.inject({ method: "PATCH", url: `/api/charts/${chart.id}/draft`, headers, payload: { ...content, performedServiceDetail: "訂正版の施術内容", expectedVersion: chart.version } });
      assert.equal(changed.statusCode, 200);
      chart = changed.json<TestChart>();
      assert.equal(chart.revisions[0].performedServiceDetail, "訂正版の施術内容");
      assert.ok(["施術A", "施術B"].includes(chart.revisions[1].performedServiceDetail));
      const secondFinal = await server.inject({ method: "POST", url: `/api/charts/${chart.id}/finalize`, headers, payload: { expectedVersion: chart.version } });
      assert.equal(secondFinal.statusCode, 200);
      chart = secondFinal.json<TestChart>();
      assert.deepEqual(chart.revisions.map((revision) => revision.status), ["FINALIZED", "FINALIZED"]);
    });

    await t.test("reservation/master changes cannot silently rewrite treatment context", async () => {
      await prisma.customer.update({ where: { id: customer.id }, data: { name: "改名後" } });
      await prisma.staff.update({ where: { id: staff.id }, data: { name: "改名後担当" } });
      await prisma.service.update({ where: { id: service.id }, data: { name: "改名後メニュー" } });
      await prisma.reservation.update({ where: { id: reservation.id }, data: { staffId: null, startsAt: new Date("2026-10-20T02:00:00Z") } });
      const result = await server.inject({ method: "GET", url: `/api/charts/${chart.id}`, headers });
      assert.equal(result.statusCode, 200);
      const record = result.json<TestChart & { serviceName: string; staffName: string; startsAt: string }>();
      assert.equal(record.customerName, "検証顧客");
      assert.equal(record.staffName, "担当A");
      assert.equal(record.serviceName, "腕の施術");
      assert.equal(record.startsAt, "2026-10-13T02:00:00.000Z");
    });

    const limitedUser = await prisma.appUser.create({ data: { firebaseUid: `${prefix}-limited`, displayName: "権限変更検証" } });
    userIds.push(limitedUser.id);
    const limitedMembership = await prisma.tenantMembership.create({ data: {
      tenantId: a.tenant.id, userId: limitedUser.id, role: "STAFF", useCustomPermissions: true,
      permissions: ["chart.read", "chart.write"], salonIds: [a.salon.id]
    } });
    contexts.limited = { ...a, user: limitedUser, membership: limitedMembership };
    const limitedHeaders = { "x-test-scope": "limited" };
    const secondaryReservation = await prisma.reservation.create({ data: {
      tenantId: a.tenant.id, salonId: a.salon.id, customerId: customer.id, staffId: staff.id, serviceId: service.id,
      startsAt: new Date("2026-10-14T02:00:00Z"), endsAt: new Date("2026-10-14T02:30:00Z")
    } });
    const createdDraft = await server.inject({ method: "POST", url: "/api/charts", headers, payload: {
      ...content, reservationId: secondaryReservation.id, performedServiceDetail: "権限変更前の記録"
    } });
    assert.equal(createdDraft.statusCode, 201, createdDraft.body);
    let permissionDraft = createdDraft.json<TestChart>();
    const uploaded = await server.inject({ method: "POST", url: `/api/charts/${permissionDraft.id}/photos?expectedVersion=${permissionDraft.version}&phase=BEFORE`, headers: { ...headers, "content-type": "image/png" }, payload: photo });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    permissionDraft = uploaded.json<TestChart>();
    const unusedReservation = await prisma.reservation.create({ data: {
      tenantId: a.tenant.id, salonId: a.salon.id, customerId: customer.id, staffId: staff.id, serviceId: service.id,
      startsAt: new Date("2026-10-15T02:00:00Z"), endsAt: new Date("2026-10-15T02:30:00Z")
    } });
    const membershipKey = { tenantId_userId: { tenantId: a.tenant.id, userId: limitedUser.id } };
    const draftMutation = () => server.inject({ method: "PATCH", url: `/api/charts/${permissionDraft.id}/draft`, headers: limitedHeaders, payload: { ...content, expectedVersion: permissionDraft.version, performedServiceDetail: "保存してはいけない内容" } });

    await t.test("all chart mutations reject authority revoked after initial authorization", async () => {
      const auditCount = await prisma.auditLog.count({ where: { tenantId: a.tenant.id } });
      await prisma.tenantMembership.update({ where: membershipKey, data: { permissions: ["chart.read"] } });
      const requests = [
        () => server.inject({ method: "POST", url: "/api/charts", headers: limitedHeaders, payload: { ...content, reservationId: unusedReservation.id } }),
        draftMutation,
        () => server.inject({ method: "POST", url: `/api/charts/${permissionDraft.id}/finalize`, headers: limitedHeaders, payload: { expectedVersion: permissionDraft.version } }),
        () => server.inject({ method: "POST", url: `/api/charts/${chart.id}/amend`, headers: limitedHeaders, payload: { expectedVersion: chart.version, reason: "権限変更後の訂正" } }),
        () => server.inject({ method: "POST", url: `/api/charts/${permissionDraft.id}/photos?expectedVersion=${permissionDraft.version}&phase=AFTER`, headers: { ...limitedHeaders, "content-type": "image/png" }, payload: photo }),
        () => server.inject({ method: "DELETE", url: `/api/charts/${permissionDraft.id}/photos/${permissionDraft.revisions[0].photos[0].id}`, headers: limitedHeaders, payload: { expectedVersion: permissionDraft.version } })
      ];
      for (const request of requests) {
        const result = await request();
        assert.equal(result.statusCode, 403, result.body);
        assert.equal(result.json<{ code: string }>().code, "OPERATION_REJECTED");
      }
      assert.equal(await prisma.treatmentChart.count({ where: { reservationId: unusedReservation.id } }), 0);
      assert.equal((await prisma.treatmentChart.findUniqueOrThrow({ where: { id: permissionDraft.id } })).version, permissionDraft.version);
      assert.equal((await prisma.treatmentChart.findUniqueOrThrow({ where: { id: chart.id } })).version, chart.version);
      assert.equal(await prisma.auditLog.count({ where: { tenantId: a.tenant.id } }), auditCount);
      await prisma.tenantMembership.update({ where: membershipKey, data: { permissions: ["chart.read", "chart.write"] } });
    });

    await t.test("latest salon scope, membership, account and tenant state are enforced", async () => {
      await prisma.tenantMembership.update({ where: membershipKey, data: { salonIds: [otherSalon.id] } });
      assert.equal((await draftMutation()).statusCode, 403);
      await prisma.tenantMembership.update({ where: membershipKey, data: { salonIds: [a.salon.id], status: "SUSPENDED" } });
      assert.equal((await draftMutation()).statusCode, 403);
      await prisma.tenantMembership.update({ where: membershipKey, data: { status: "ACTIVE" } });
      await prisma.appUser.update({ where: { id: limitedUser.id }, data: { disabled: true } });
      assert.equal((await draftMutation()).statusCode, 403);
      await prisma.appUser.update({ where: { id: limitedUser.id }, data: { disabled: false } });
      await prisma.tenant.update({ where: { id: a.tenant.id }, data: { status: "SUSPENDED" } });
      assert.equal((await draftMutation()).statusCode, 403);
      await prisma.tenant.update({ where: { id: a.tenant.id }, data: { status: "ACTIVE" } });
      assert.equal((await prisma.treatmentChart.findUniqueOrThrow({ where: { id: permissionDraft.id } })).version, permissionDraft.version);
    });

    await t.test("permission revocation committed during a real row-lock wait rejects the pending write", async () => {
      let unlock!: () => void;
      let notifyLocked!: (pid: number) => void;
      const locked = new Promise<number>((resolve) => { notifyLocked = resolve; });
      const release = new Promise<void>((resolve) => { unlock = resolve; });
      const holdingTransaction = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${a.tenant.id} FOR UPDATE`;
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        notifyLocked(backend.pid);
        await release;
        await tx.tenantMembership.update({ where: membershipKey, data: { permissions: ["chart.read"] } });
      }, { timeout: 10000 });
      const pid = await locked;
      const pendingMutation = draftMutation();
      try {
        const deadline = Date.now() + 5000;
        let observedWait = false;
        while (Date.now() < deadline) {
          const blocked = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
          if (blocked.length) { observedWait = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(observedWait, true, "The request must actually wait on the access-management tenant lock");
      } finally {
        unlock();
        await holdingTransaction;
      }
      const rejected = await pendingMutation;
      assert.equal(rejected.statusCode, 403, rejected.body);
      assert.equal((await prisma.treatmentChart.findUniqueOrThrow({ where: { id: permissionDraft.id } })).version, permissionDraft.version);
    });
  } finally {
    await server.close();
    if (tenantIds.length) {
      const scope = { tenantId: { in: tenantIds } };
      await prisma.treatmentChartRevisionPhoto.deleteMany({ where: scope });
      await prisma.treatmentChartPhoto.deleteMany({ where: scope });
      await prisma.treatmentChartRevision.deleteMany({ where: scope });
      await prisma.treatmentChart.deleteMany({ where: scope });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (userIds.length) await prisma.appUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }
});
