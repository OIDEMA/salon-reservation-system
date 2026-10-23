import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareStaffImport, staffImportEnvelopeSchema, staffNaturalKey, staffPublicationKey } from "../src/staff-import.js";

const store = "H000551123";
const name = "検証 スタッフ";
const kana = "ケンショウ スタッフ";
const record = {
  externalRecordKey: staffNaturalKey(store, name, kana), name, kana, role: "ESTHETICIAN",
  parallelCapacity: 2, allocationOrder: 1, sortOrder: 0, active: true,
  profile: { "スタッフ紹介": "SYNTHETIC PROFILE", experience: { years: 5 }, menus: ["Synthetic treatment"], sourceDisabled: false }
};
const envelope = (records: unknown[] = [record]) => ({
  version: 1, source: "SALONBOARD", sourceStoreId: store,
  capturedAt: "2026-10-14T01:00:00Z", expectedCount: records.length, records
});

test("staff snapshot identity is scoped and normalized without merging different kana", () => {
  const expected = createHash("sha256").update(JSON.stringify([store, name, kana])).digest("hex");
  assert.equal(staffNaturalKey(store, ` ${name} `, ` ${kana} `), expected);
  assert.equal(staffNaturalKey(store, "　ＡＢＣ　", "　ｽﾀｯﾌ　"), staffNaturalKey(store, "ABC", "スタッフ"));
  assert.notEqual(staffNaturalKey("H000999999", name, kana), expected);
  assert.notEqual(staffNaturalKey(store, name, "ベツノ スタッフ"), expected);
  assert.notEqual(staffNaturalKey(store, "ab", "c"), staffNaturalKey(store, "a", "bc"));
  assert.notEqual(staffNaturalKey(store, "検証 スタッフ", kana), staffNaturalKey(store, "検証スタッフ", kana));
});

test("staff manifest has stable checksums and preserves source profile values", () => {
  const original = prepareStaffImport(envelope());
  const reversed = prepareStaffImport(envelope([{ ...record,
    profile: { sourceDisabled: false, menus: ["Synthetic treatment"], experience: { years: 5 }, "スタッフ紹介": "SYNTHETIC PROFILE" }
  }]));
  assert.equal(original.checksum, reversed.checksum);
  assert.match(original.checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(original.envelope.records[0].profile, record.profile);
  assert.notEqual(original.checksum, prepareStaffImport({ ...envelope(), capturedAt: "2026-10-14T02:00:00Z" }).checksum);
  assert.equal(staffImportEnvelopeSchema.parse(envelope()).expectedCount, 1);
});

test("publication staff IDs remain stable across source name changes and cannot be forged or duplicated", () => {
  const publicationStaffId = "SYNTHETIC-PUBLICATION-001";
  const externalRecordKey = staffPublicationKey(store, publicationStaffId);
  assert.equal(externalRecordKey, createHash("sha256").update(JSON.stringify([store, "STAFF_PUBLICATION", publicationStaffId])).digest("hex"));
  assert.notEqual(externalRecordKey, staffPublicationKey("H000999999", publicationStaffId));
  assert.notEqual(externalRecordKey, staffPublicationKey(store, "SYNTHETIC-PUBLICATION-002"));
  const published = { ...record, publicationStaffId, externalRecordKey };
  assert.equal(prepareStaffImport(envelope([published])).envelope.records[0].publicationStaffId, publicationStaffId);
  assert.equal(prepareStaffImport(envelope([{ ...published, name: "Source name changed", kana: "Source kana changed" }])).envelope.records[0].externalRecordKey, externalRecordKey);
  assert.equal(prepareStaffImport(envelope([published, { ...published, publicationStaffId: "SYNTHETIC-PUBLICATION-002", externalRecordKey: staffPublicationKey(store, "SYNTHETIC-PUBLICATION-002") }])).envelope.records.length, 2);
  assert.throws(() => prepareStaffImport(envelope([{ ...published, externalRecordKey: record.externalRecordKey }])));
  assert.throws(() => prepareStaffImport(envelope([{ ...record, externalRecordKey }])));
  assert.throws(() => prepareStaffImport(envelope([published, { ...published, name: "Source name changed", kana: "Source kana changed" }])));
  for (const invalid of ["", "id.with.dot", "id/with/slash", "id with spaces", "ｓｔａｆｆ", "-invalid-start", "x".repeat(161)]) {
    assert.throws(() => prepareStaffImport(envelope([{ ...published, publicationStaffId: invalid, externalRecordKey: staffPublicationKey(store, invalid) }])));
  }
});

test("confirmed nomination fees and comments accept known values and reject unsafe sizes", () => {
  const parsed = prepareStaffImport(envelope([{ ...record, nominationFee: 500, comment: "Synthetic source comment" }])).envelope.records[0];
  assert.equal(parsed.nominationFee, 500); assert.equal(parsed.comment, "Synthetic source comment");
  assert.equal(prepareStaffImport(envelope([{ ...record, nominationFee: 0, comment: null }])).envelope.records[0].nominationFee, 0);
  for (const invalid of [
    { ...record, nominationFee: -1 }, { ...record, nominationFee: 1.5 }, { ...record, nominationFee: 10000001 },
    { ...record, nominationFee: "500" }, { ...record, comment: "x".repeat(1001) }, { ...record, comment: "invalid\0text" }
  ]) assert.throws(() => prepareStaffImport(envelope([invalid])));
});

test("all record identities and bounded fields are validated before import", () => {
  const invalidRecords = [
    { ...record, externalRecordKey: "a".repeat(64) },
    { ...record, externalRecordKey: record.externalRecordKey.toUpperCase() },
    { ...record, name: "" }, { ...record, name: "n".repeat(101) },
    { ...record, name: "Invalid\0Name" }, { ...record, kana: "k".repeat(101) },
    { ...record, role: "MANAGER" }, { ...record, active: "true" },
    { ...record, parallelCapacity: 0 }, { ...record, parallelCapacity: 21 }, { ...record, parallelCapacity: 1.5 },
    { ...record, allocationOrder: 0 }, { ...record, sortOrder: -1 }, { ...record, sortOrder: 1.5 },
    { ...record, unexpected: "field" }, { ...record, profile: { value: "x".repeat(10001) } },
    { ...record, profile: { value: "invalid\0text" } },
    { ...record, profile: { ["x".repeat(121)]: "value" } },
    { ...record, profile: { "invalid\0key": "value" } },
    { ...record, profile: { values: Array.from({ length: 501 }, () => 1) } },
    { ...record, profile: { a: "x".repeat(10000), b: "x".repeat(10000), c: "x".repeat(10000) } }
  ];
  for (const [index, invalid] of invalidRecords.entries()) assert.throws(() => prepareStaffImport(envelope([invalid])), `invalid staff record ${index}`);
  for (const invalid of [
    { ...envelope(), version: 2 }, { ...envelope(), source: "OTHER" }, { ...envelope(), sourceStoreId: "H000999999" },
    { ...envelope(), capturedAt: "invalid" }, { ...envelope(), expectedCount: 2 }, { ...envelope(), unexpected: true },
    envelope([]), envelope(Array.from({ length: 101 }, () => record)), envelope([record, record]),
    envelope([record, { ...record, name: ` ${name} `, kana: ` ${kana} ` }])
  ]) assert.throws(() => prepareStaffImport(invalid));
});

test("management placeholders remain inactive room resources", () => {
  const room = { ...record, name: "Synthetic management room", kana: "", role: "ROOM_RESOURCE", active: false,
    externalRecordKey: staffNaturalKey(store, "Synthetic management room", "") };
  const parsed = prepareStaffImport(envelope([room])).envelope.records[0];
  assert.equal(parsed.role, "ROOM_RESOURCE"); assert.equal(parsed.active, false);
  assert.throws(() => prepareStaffImport(envelope([{ ...room, active: true }])));
});

test("unsupported import sources are rejected without displaying the internal source name", () => {
  for (const source of ["OTHER", "", null, undefined, 0]) {
    const result = staffImportEnvelopeSchema.safeParse({ ...envelope(), source });
    assert.equal(result.success, false);
    if (result.success) continue;
    const issue = result.error.issues.find((entry) => entry.path[0] === "source");
    assert.equal(issue?.message, "取込ファイルの形式を確認してください。");
    assert.equal(result.error.issues.some((entry) => /SALONBOARD/i.test(entry.message)), false);
  }
});
