import assert from "node:assert/strict";
import test from "node:test";
import { buildHistoryStaffLinkPlan, historyStaffSnapshotKey } from "../src/history-staff-links.js";
import { staffPublicationKey } from "../src/staff-import.js";

const store = "H000551123";
const current = { id: "STAFF-LOCAL-001", name: "MANUALLY RENAMED", role: "MANAGER" as const, active: true };
const sourceRecord = (id: string, name: string | null, publication: string | null = null, staffId: string | null = null) => ({
  id, externalReservationId: `SOURCE-${id}`, externalStaffId: publication, staffName: name, staffId
});

test("legacy staff snapshot identities retain source spacing, width and store boundaries", () => {
  const exact = historyStaffSnapshotKey(store, "旧 担当Ａ");
  assert.match(exact, /^[0-9a-f]{64}$/);
  assert.equal(exact, historyStaffSnapshotKey(store, "旧 担当Ａ"));
  assert.notEqual(exact, historyStaffSnapshotKey(store, "旧担当A"));
  assert.notEqual(exact, historyStaffSnapshotKey(store, "旧 担当Ａ "));
  assert.notEqual(exact, historyStaffSnapshotKey("H000999999", "旧 担当Ａ"));
  assert.notEqual(exact, staffPublicationKey(store, "旧 担当Ａ"));
});

test("publication IDs bind current renamed targets while generated legacy IDs and completed links do not change the plan checksum", () => {
  const records = [sourceRecord("1", "SOURCE CURRENT NAME", "PUBLICATION-001"), sourceRecord("2", "OLD LABEL"), sourceRecord("3", "OLD LABEL")];
  const currentMapping = { externalRecordKey: staffPublicationKey(store, "PUBLICATION-001"), staff: current };
  const original = buildHistoryStaffLinkPlan(records, [currentMapping], [current]);
  assert.equal(original.ready, true); assert.equal(original.totalCount, 3); assert.equal(original.pendingCount, 3);
  assert.equal(original.existingStaffCount, 1); assert.equal(original.newStaffCount, 1);
  assert.equal(original.groups.find((group) => group.staffId === current.id)?.sourceStaffName, "SOURCE CURRENT NAME");
  const legacy = { id: "GENERATED-STAFF-002", name: "MANUAL LEGACY RENAME", role: "ESTHETICIAN" as const, active: false };
  const linked = buildHistoryStaffLinkPlan([
    { ...records[0], staffId: current.id }, { ...records[1], staffId: legacy.id }, { ...records[2], staffId: legacy.id }
  ], [currentMapping, { externalRecordKey: historyStaffSnapshotKey(store, "OLD LABEL"), staff: legacy }], [current, legacy]);
  assert.equal(linked.ready, true); assert.equal(linked.checksum, original.checksum);
  assert.equal(linked.linkedCount, 3); assert.equal(linked.pendingCount, 0); assert.equal(linked.newStaffCount, 0);
  const reassigned = buildHistoryStaffLinkPlan(records, [{ ...currentMapping, staff: { ...current, id: "DIFFERENT-MASTER" } }], [current]);
  assert.notEqual(reassigned.checksum, original.checksum);
});

test("unmapped matching local names and existing conflicting links require review rather than automatic merging", () => {
  const legacyRecord = sourceRecord("1", "旧 担当Ａ");
  const matching = { ...current, name: "旧担当A" };
  const collision = buildHistoryStaffLinkPlan([legacyRecord], [], [matching]);
  assert.equal(collision.ready, false); assert.equal(collision.groups[0].staffId, null);
  const mismatched = buildHistoryStaffLinkPlan([{ ...legacyRecord, staffId: current.id }], [], [current]);
  assert.equal(mismatched.ready, false);
  assert(mismatched.issues.length > 0);
});

test("unknown, empty or ambiguous source staff identities never become ready automatically", () => {
  for (const records of [[], [sourceRecord("1", null)], [sourceRecord("1", "  ")], [sourceRecord("1", "KNOWN NAME", "MISSING-PUBLICATION")]]) {
    assert.equal(buildHistoryStaffLinkPlan(records, [], [current]).ready, false);
  }
  const mapping = { externalRecordKey: staffPublicationKey(store, "PUBLICATION-001"), staff: current };
  const ambiguity = buildHistoryStaffLinkPlan([sourceRecord("1", "SOURCE NAME A", "PUBLICATION-001"), sourceRecord("2", "SOURCE NAME B", "PUBLICATION-001")], [mapping], [current]);
  assert.equal(ambiguity.ready, false);
  assert.equal(ambiguity.totalCount, 2);
});

test("source resource labels remain inactive resource frames without changing their exact identity", () => {
  const records = [sourceRecord("1", "既存 身体"), sourceRecord("2", "新規 全身"), sourceRecord("3", "OLD PERSON")];
  const plan = buildHistoryStaffLinkPlan(records, [], []);
  assert.equal(plan.ready, true);
  assert.equal(plan.newStaffCount, 3);
  for (const group of plan.groups) {
    assert.equal(group.active, false); assert.equal(group.action, "CREATE_INACTIVE");
    assert.equal(group.role, group.sourceStaffName === "OLD PERSON" ? "ESTHETICIAN" : "ROOM_RESOURCE");
    assert.equal(group.key, historyStaffSnapshotKey(store, group.sourceStaffName));
  }
});
