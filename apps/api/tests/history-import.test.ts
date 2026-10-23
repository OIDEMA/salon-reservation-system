import assert from "node:assert/strict";
import test from "node:test";
import { importChecksum } from "../src/customer-import.js";
import {
  HISTORY_IMPORT_BODY_LIMIT, HISTORY_IMPORT_CHUNK_SIZE, HISTORY_IMPORT_RAW_ROW_LIMIT,
  historyImportChunkSchema, historyImportEnvelopeSchema, historyJstDate, historyJstMidnight,
  historyPageQuerySchema, historyReservationRecordSchema, nextHistoryDate, normalizedHistoryStatus, prepareHistoryManifest
} from "../src/history-import.js";

const record = {
  externalReservationId: "SYNTHETIC-R-001", externalCustomerId: "SYNTHETIC-C-001", customerNumber: "SYNTHETIC-01", externalStaffId: null,
  customerName: "SYNTHETIC Customer", customerKana: null, staffName: "SYNTHETIC staff", sourceStatus: "来店済み",
  startsAt: "2025-10-14T10:00:00+09:00", endsAt: "2025-10-14T11:00:00+09:00", durationMinutes: 60,
  menuText: "SYNTHETIC menu", reservationAmount: 5000, sourceRoute: "SYNTHETIC route", nominated: false,
  equipmentName: null, rawHeaders: ["メモ", "メモ", "予約番号"], rawValues: ["  SYNTHETIC note\nline 2  ", "", "SYNTHETIC-R-001"]
};
const envelope = { version: 1, source: "SALONBOARD", sourceStoreId: "H000551123", periodFrom: "2025-10-14", periodTo: "2026-10-14",
  capturedAt: "2026-10-14T01:00:00Z", expectedCount: 1, records: [record] };

test("a prepared history manifest preserves duplicate source columns and raw whitespace", () => {
  const prepared = prepareHistoryManifest(envelope);
  assert.deepEqual(prepared.envelope.records[0].rawHeaders, record.rawHeaders);
  assert.deepEqual(prepared.envelope.records[0].rawValues, record.rawValues);
  assert.equal(prepared.envelope.records[0].reservationAmount, 5000);
  assert.match(prepared.checksum, /^[0-9a-f]{64}$/);
  assert.equal(prepared.recordHashes[0], importChecksum(record));
  assert.deepEqual({ ...prepared.monthCounts }, { "2025-10": 1 });
  assert.deepEqual({ ...prepared.statusCounts }, { "来店済み": 1 });
  assert.equal(HISTORY_IMPORT_CHUNK_SIZE, 50);
  assert.equal(HISTORY_IMPORT_BODY_LIMIT, 20 * 1024 * 1024);
});

test("timestamps require an explicit timezone and nullable unknown source values stay null", () => {
  for (const startsAt of ["2025-10-14T10:00:00", "invalid", "2025-02-30T10:00:00Z", "2025-10-14"]) {
    assert.equal(historyReservationRecordSchema.safeParse({ ...record, startsAt }).success, false);
    assert.throws(() => prepareHistoryManifest({ ...envelope, records: [{ ...record, startsAt }] }));
  }
  const unknown = historyReservationRecordSchema.parse({ ...record, externalCustomerId: null, externalStaffId: null,
    customerNumber: null, endsAt: null, durationMinutes: null, reservationAmount: null, nominated: null });
  assert.equal(unknown.endsAt, null); assert.equal(unknown.durationMinutes, null); assert.equal(unknown.reservationAmount, null);
  assert.equal(unknown.nominated, null); assert.equal(unknown.externalStaffId, null);
});

test("target period is an inclusive/exclusive real JST date interval", () => {
  const startBoundary = { ...record, startsAt: "2025-10-13T15:00:00Z", endsAt: null };
  assert.equal(historyImportEnvelopeSchema.safeParse({ ...envelope, records: [startBoundary] }).success, true);
  assert.equal(historyImportEnvelopeSchema.safeParse({ ...envelope, records: [{ ...startBoundary, startsAt: "2025-10-13T14:59:59Z" }] }).success, false);
  assert.equal(historyImportEnvelopeSchema.safeParse({ ...envelope, records: [{ ...startBoundary, startsAt: "2026-10-13T14:59:59Z" }] }).success, true);
  assert.equal(historyImportEnvelopeSchema.safeParse({ ...envelope, records: [{ ...startBoundary, startsAt: "2026-10-13T15:00:00Z" }] }).success, false);
  assert.equal(historyImportEnvelopeSchema.safeParse({ ...envelope, periodFrom: "2025-02-30" }).success, false);
  assert.equal(historyImportEnvelopeSchema.safeParse({ ...envelope, periodTo: envelope.periodFrom }).success, false);
  assert.equal(historyJstDate("2025-10-13T15:00:00Z"), "2025-10-14");
  assert.equal(historyJstMidnight("2025-10-14").toISOString(), "2025-10-13T15:00:00.000Z");
  assert.equal(nextHistoryDate("2024-02-28"), "2024-02-29");
  assert.equal(nextHistoryDate("2025-12-31"), "2026-01-01");
});

test("all source rows validate before preparation, including totals, duplicate IDs and strict fields", () => {
  for (const invalid of [
    { ...envelope, expectedCount: 0 }, { ...envelope, expectedCount: 2 }, { ...envelope, expectedCount: 10001 },
    { ...envelope, expectedCount: 2, records: [record, record] }, { ...envelope, sourceStoreId: "H000999999" },
    { ...envelope, source: "OTHER" }, { ...envelope, tenantId: "client-cannot-set-scope" },
    { ...envelope, records: [{ ...record, customerName: "" }] },
    { ...envelope, records: [{ ...record, externalReservationId: "\0bad" }] },
    { ...envelope, records: [{ ...record, staffId: "client-cannot-create-mapping" }] }
  ]) assert.equal(historyImportEnvelopeSchema.safeParse(invalid).success, false);
});

test("nullable source fields are explicit, numbers/end times are bounded and no derived values are invented", () => {
  for (const changes of [
    { endsAt: record.startsAt }, { endsAt: "2025-10-14T09:59:59+09:00" }, { durationMinutes: 0 },
    { durationMinutes: 1.5 }, { durationMinutes: 10081 }, { reservationAmount: -1 },
    { reservationAmount: 1.5 }, { reservationAmount: 2147483648 }, { nominated: "false" },
    { externalCustomerId: "not an identifier" }, { rawHeaders: [] }, { rawValues: [] }, { rawHeaders: ["one"] }
  ]) assert.equal(historyReservationRecordSchema.safeParse({ ...record, ...changes }).success, false);
  assert.equal(historyReservationRecordSchema.safeParse({ ...record, reservationAmount: 0, durationMinutes: 1, nominated: null }).success, true);
});

test("raw source arrays keep duplicate labels and enforce columns/UTF-8 byte size", () => {
  const oversized = { ...record, rawHeaders: ["private"], rawValues: ["あ".repeat(Math.ceil(HISTORY_IMPORT_RAW_ROW_LIMIT / 3))] };
  assert.equal(historyReservationRecordSchema.safeParse(oversized).success, false);
  assert.equal(historyReservationRecordSchema.safeParse({ ...record, rawHeaders: Array(201).fill("h"), rawValues: Array(201).fill("v") }).success, false);
  assert.equal(historyReservationRecordSchema.safeParse({ ...record, rawHeaders: ["h\0"], rawValues: ["v"] }).success, false);
  assert.equal(historyReservationRecordSchema.safeParse({ ...record, rawHeaders: ["h"], rawValues: ["v\0"] }).success, false);
  assert.equal(historyReservationRecordSchema.safeParse({ ...record, rawHeaders: ["h"], rawValues: [" x\n y\r\n z "] }).success, true);
});

test("a complete manifest is bounded to twenty MiB even when each raw row is valid", () => {
  const boundedRow = { ...record, rawHeaders: ["private"], rawValues: ["x".repeat(60000)] };
  assert.equal(historyReservationRecordSchema.safeParse(boundedRow).success, true);
  const oversized = { ...envelope, expectedCount: 400,
    records: Array.from({ length: 400 }, (_, index) => ({ ...boundedRow, externalReservationId: `SYNTHETIC-SIZE-${index}` })) };
  assert.equal(historyImportEnvelopeSchema.safeParse(oversized).success, false);
});

test("canonical manifest hashes retain source column ordering and reject any source changes", () => {
  const original = prepareHistoryManifest(envelope);
  const reversedKeys = Object.fromEntries(Object.entries(envelope).reverse());
  assert.equal(prepareHistoryManifest(reversedKeys).checksum, original.checksum);
  for (const changed of [
    { ...record, sourceStatus: "キャンセル" }, { ...record, rawValues: [...record.rawValues].reverse() },
    { ...record, customerName: "SYNTHETIC changed" }, { ...record, reservationAmount: null },
    { ...record, rawHeaders: [...record.rawHeaders].reverse() }
  ]) assert.notEqual(prepareHistoryManifest({ ...envelope, records: [changed] }).checksum, original.checksum);
});

test("monthly counts use JST and count every source status including unknown labels", () => {
  const prepared = prepareHistoryManifest({ ...envelope, expectedCount: 3, records: [
    record,
    { ...record, externalReservationId: "SYNTHETIC-R-002", startsAt: "2025-10-31T15:00:00Z", endsAt: null, sourceStatus: "UNKNOWN SOURCE STATE" },
    { ...record, externalReservationId: "SYNTHETIC-R-003", startsAt: "2025-11-01T00:00:00+09:00", endsAt: null, sourceStatus: "キャンセル" }
  ] });
  assert.deepEqual({ ...prepared.monthCounts }, { "2025-10": 1, "2025-11": 2 });
  assert.deepEqual({ ...prepared.statusCounts }, { "来店済み": 1, "UNKNOWN SOURCE STATE": 1, "キャンセル": 1 });
});

test("normalization is conservative and cannot assume past dates are completed", () => {
  assert.equal(normalizedHistoryStatus("来店済み"), "COMPLETED");
  assert.equal(normalizedHistoryStatus("予約確定"), "CONFIRMED");
  assert.equal(normalizedHistoryStatus("キャンセル"), "CANCELLED");
  assert.equal(normalizedHistoryStatus("無断キャンセル"), "NO_SHOW");
  for (const unknown of ["UNKNOWN SOURCE STATE", "終了", "来店済み（不明）", "__proto__", "COMPLETED"]) assert.equal(normalizedHistoryStatus(unknown), null);
});

test("prototype-like source statuses are literal safe count keys", () => {
  const prepared = prepareHistoryManifest({ ...envelope, records: [{ ...record, sourceStatus: "__proto__" }] });
  assert.equal(prepared.statusCounts["__proto__"], 1);
  assert.equal(Object.getPrototypeOf(prepared.statusCounts), null);
});

test("chunks allow only fifty-boundaries, up to fifty validated records and no injected fields", () => {
  assert.equal(historyImportChunkSchema.safeParse({ offset: 50, records: [record] }).success, true);
  for (const invalid of [
    { offset: -50, records: [record] }, { offset: 1, records: [record] }, { offset: 10000, records: [record] },
    { offset: 0, records: [] }, { offset: 0, records: Array(51).fill(record) },
    { offset: 0, records: [record], expectedCount: 1 }, { offset: 0, records: [{ ...record, rawValues: [] }] }
  ]) assert.equal(historyImportChunkSchema.safeParse(invalid).success, false);
});

test("history page queries validate actual dates, inclusive same-day ranges and bounded API pagination", () => {
  assert.deepEqual(historyPageQuerySchema.parse({}), { q: "", page: 1, pageSize: 50 });
  assert.deepEqual(historyPageQuerySchema.parse({ page: "2", pageSize: "100", from: "2025-12-31", to: "2025-12-31" }), { q: "", page: 2, pageSize: 100, from: "2025-12-31", to: "2025-12-31" });
  for (const invalid of [
    { q: "a".repeat(101) }, { page: "0" }, { page: "1.1" }, { pageSize: "101" }, { pageSize: "0" },
    { from: "2025-02-30" }, { from: "2025-12-31", to: "2025-12-30" }, { sourceStatus: "" },
    { status: "COMPLETED" }, { page: ["1", "2"] }
  ]) assert.equal(historyPageQuerySchema.safeParse(invalid).success, false);
});

test("unsupported import sources are rejected without displaying the internal source name", () => {
  for (const source of ["OTHER", "", null, undefined, 0]) {
    const result = historyImportEnvelopeSchema.safeParse({ ...envelope, source });
    assert.equal(result.success, false);
    if (result.success) continue;
    const issue = result.error.issues.find((entry) => entry.path[0] === "source");
    assert.equal(issue?.message, "取込ファイルの形式を確認してください。");
    assert.equal(result.error.issues.some((entry) => /SALONBOARD/i.test(entry.message)), false);
  }
});
