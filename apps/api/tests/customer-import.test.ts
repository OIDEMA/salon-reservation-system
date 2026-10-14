import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson, customerExternalDetail, importChecksum, prepareSalonboardManifest,
  salonboardImportChunkSchema, salonboardRecordProfile, type SalonboardCustomerRecord
} from "../src/customer-import.js";

const record: SalonboardCustomerRecord = {
  externalCustomerId: "C014000000001", name: "検証 花子", kana: "ケンショウ ハナコ", customerNumber: "受付-001", gender: "女性",
  occupation: "会社員", sourceVisitCount: 12, sourceLastVisitDate: "2026/10/13(火)",
  profile: { "氏名 (漢字)": " 検証 花子 ", "電話番号1": "０９０－１２３４－５６７８", "電話番号2": "087-111-2222",
    "E-MAIL (PC)": "person@example.test", "E-MAIL (携帯)": "mobile@example.test", "誕生日": "1990/2/3", "住所": "検証県検証市", "郵便番号": "123-4567", "お客様メモ": "PRIVATE CLINICAL TEST NOTE" }
};
const envelope = (records = [record]) => ({ version: 1, source: "SALONBOARD", sourceStoreId: "H000551123", expectedCount: records.length, capturedAt: "2026-10-14T01:00:00Z", records });

test("manifest validates the entire input before processing and uses stable canonical hashes", () => {
  const a = prepareSalonboardManifest(envelope());
  const b = prepareSalonboardManifest({ ...envelope(), records: [{ ...record, profile: Object.fromEntries(Object.entries(record.profile!).reverse()) }] });
  assert.equal(a.checksum, b.checksum); assert.deepEqual(a.recordHashes, b.recordHashes);
  assert.equal(canonicalJson({ b: 2, a: { z: 2, y: 1 } }), '{"a":{"y":1,"z":2},"b":2}');
  assert.notEqual(importChecksum({ a: 1 }), importChecksum({ a: 2 }));
  assert.equal(a.envelope.records[0].profile!["氏名 (漢字)"], " 検証 花子 ", "Original label values stay untouched");
  for (const invalid of [
    { ...envelope(), expectedCount: 1050 },
    envelope([record, record]),
    { ...envelope(), records: [{ ...record, name: "" }] },
    { ...envelope(), sourceStoreId: "OTHER_STORE" },
    { ...envelope(), unexpected: true },
    { ...envelope(), records: [{ ...record, profile: { "電話番号1": "1".repeat(31) } }] },
    { ...envelope(), records: [{ ...record, profile: { "お客様メモ": "x".repeat(4001) } }] },
    { ...envelope(), records: [{ ...record, profile: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`key${index}`, "v"])) }] }
  ]) assert.throws(() => prepareSalonboardManifest(invalid));
});

test("chunk validation is bounded and uses fixed 50-row offsets", () => {
  assert.equal(salonboardImportChunkSchema.parse({ offset: 50, records: [record] }).offset, 50);
  for (const input of [{ offset: 1, records: [record] }, { offset: 0, records: [] }, { offset: 0, records: Array.from({ length: 51 }, () => record) }]) {
    assert.throws(() => salonboardImportChunkSchema.parse(input));
  }
});

test("known contact labels project separately and raw notes require chart access", () => {
  const profile = salonboardRecordProfile(record, "2026-10-14T01:00:00Z");
  assert.equal(profile.phone, "０９０－１２３４－５６７８"); assert.equal(profile.phone2, "087-111-2222");
  assert.equal(profile.email, "person@example.test"); assert.equal(profile.mobileEmail, "mobile@example.test");
  assert.equal(profile.birthDate, "1990-02-03"); assert.equal(profile.sourceLastVisitDate, "2026-10-13");
  const external = { source: "SALONBOARD", sourceStoreId: "H000551123", externalCustomerId: record.externalCustomerId, importedAt: new Date("2026-10-14T02:00:00Z"), profile };
  const withoutNotes = customerExternalDetail(external, false);
  assert.equal(withoutNotes.sourceVisitCount, 12); assert.equal(withoutNotes.sourceLastVisitDateRaw, "2026/10/13(火)");
  assert.equal("visitCount" in withoutNotes, false); assert.equal("profile" in withoutNotes, false);
  assert.equal(JSON.stringify(withoutNotes).includes("PRIVATE CLINICAL"), false);
  assert.equal((customerExternalDetail(external, true).profile as Record<string, string>)["お客様メモ"], "PRIVATE CLINICAL TEST NOTE");
  assert.equal(salonboardRecordProfile({ ...record, phone: "070-9999-8888" }, external.importedAt.toISOString()).phone, "070-9999-8888");
  assert.equal(salonboardRecordProfile({ ...record, birthDate: "1990/2/30", sourceLastVisitDate: "2026/2/31" }, external.importedAt.toISOString()).birthDate, null);
});
