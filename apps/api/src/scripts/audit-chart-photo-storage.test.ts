import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditChartPhotoStorage, chartPhotoStorageInventory, parseChartPhotoAuditArguments, type ChartPhotoAuditReference, type ChartPhotoInventoryItem
} from "./audit-chart-photo-storage.js";

const bucket = "private-chart-photos";
const now = new Date("2026-10-15T12:00:00Z");
const options = { bucket, configuredBucket: bucket, olderThanHours: 24, now };
const marker = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
function object(id: string, override: Partial<ChartPhotoInventoryItem> = {}): ChartPhotoInventoryItem {
  return { name: `chart-photos/t/s/c/${id}`, generation: "9007199254740993", timeCreated: "2026-10-13T12:00:00Z", uploadId: marker, ...override };
}
function reference(id: string, override: Partial<ChartPhotoAuditReference> = {}): ChartPhotoAuditReference {
  return { id, tenantId: "t", salonId: "s", chartId: "c", storageBucket: bucket,
    storagePath: `chart-photos/t/s/c/${id}`, storageGeneration: "9007199254740993", pendingDeletion: false, revisionLinkCount: 1, ...override };
}
async function audit(items: ChartPhotoInventoryItem[], rows: Record<string, ChartPhotoAuditReference[]>) {
  const lookedUp: string[] = [];
  const report = await auditChartPhotoStorage(options, {
    async *inventory(actualBucket) { assert.equal(actualBucket, bucket); yield* items; },
    async references({ photoId }) { lookedUp.push(photoId); return rows[photoId] ?? []; }
  });
  return { report, lookedUp };
}

test("audit requires explicit matching bucket and age >= 24 before accessing dependencies", async () => {
  assert.deepEqual(parseChartPhotoAuditArguments(["--bucket", bucket, "--older-than-hours", "48"], bucket),
    { bucket, configuredBucket: bucket, olderThanHours: 48 });
  for (const args of [[], ["--bucket", bucket], ["--bucket", "other-bucket", "--older-than-hours", "24"],
    ["--bucket", bucket, "--older-than-hours", "23"], ["--bucket", bucket, "--older-than-hours", "NaN"],
    ["--bucket", bucket, "--bucket", bucket]]) assert.throws(() => parseChartPhotoAuditArguments(args, bucket));
  let calls = 0;
  await assert.rejects(auditChartPhotoStorage({ ...options, olderThanHours: 0 }, {
    async *inventory() { calls++; }, async references() { calls++; return []; }
  }));
  assert.equal(calls, 0);
});

test("audit reports aged untracked objects, exact generations and lifecycle inconsistencies without mutations", async () => {
  const ids = ["healthy", "orphan", "generation", "location", "scope", "pending", "unlinked", "pendingLinked"];
  const { report } = await audit(ids.map((id) => object(id)), {
    healthy: [reference("healthy")], generation: [reference("generation", { storageGeneration: "9007199254740992" })],
    location: [reference("location", { storagePath: "chart-photos/t/s/c/different" })],
    scope: [reference("scope", { salonId: "another-salon" })],
    pending: [reference("pending", { pendingDeletion: true, revisionLinkCount: 0 })],
    unlinked: [reference("unlinked", { revisionLinkCount: 0 })],
    pendingLinked: [reference("pendingLinked", { pendingDeletion: true })]
  });
  assert.equal(report.readOnly, true);
  assert.equal(report.manualReviewRequired, true);
  assert.equal(report.scanned, 8);
  assert.equal(report.referenced, 1);
  assert.deepEqual(report.findings.map((item) => item.reason), ["NO_DATABASE_RECORD", "GENERATION_MISMATCH",
    "LOCATION_OR_SCOPE_MISMATCH", "LOCATION_OR_SCOPE_MISMATCH", "PENDING_DELETION", "UNLINKED_DATABASE_PHOTO", "PENDING_BUT_REFERENCED"]);
  assert.equal(report.findings[0].generation, "9007199254740993");
});

test("recent or unrecognized metadata is excluded without leaking arbitrary object names", async () => {
  const { report, lookedUp } = await audit([
    object("recent", { timeCreated: "2026-10-15T11:00:00Z" }),
    object("future", { timeCreated: "2026-10-16T12:00:00Z" }),
    object("secret", { name: "customers/clinical-secret.jpg" }),
    object("unknown", { uploadId: "clinical-secret" }), object("invalid", { timeCreated: "not-a-date" }),
    object("unsafeNumber", { generation: 9007199254740992 })
  ], {});
  assert.deepEqual(lookedUp, []);
  assert.equal(report.skippedRecent, 2);
  assert.equal(report.skippedUnrecognized, 4);
  assert.equal(JSON.stringify(report).includes("clinical-secret"), false);
  assert.deepEqual(report.findings, []);
});

test("database failure aborts the report instead of labelling unknown references orphaned", async () => {
  await assert.rejects(auditChartPhotoStorage(options, {
    async *inventory() { yield object("p"); }, async references() { throw new Error("database unavailable"); }
  }), /database unavailable/);
});


test("storage inventory finishes successfully when the SDK returns null for the final page", async () => {
  let calls = 0;
  const items: ChartPhotoInventoryItem[] = [];
  for await (const item of chartPhotoStorageInventory({ async getFiles(query) {
    calls++;
    assert.deepEqual(query, { prefix: "chart-photos/", versions: true, autoPaginate: false, maxResults: 500 });
    return [[{ metadata: { name: "chart-photos/t/s/c/p", generation: "9007199254740993",
      timeCreated: "2026-10-13T12:00:00Z", metadata: { uploadId: marker } } }], null];
  } })) items.push(item);
  assert.equal(calls, 1);
  assert.deepEqual(items, [object("p")]);
});

test("storage inventory follows the next page token and stops on the final null page", async () => {
  const queries: Array<{ pageToken?: string }> = [];
  const items: ChartPhotoInventoryItem[] = [];
  for await (const item of chartPhotoStorageInventory({ async getFiles(query) {
    queries.push(query);
    const id = queries.length === 1 ? "first" : "second";
    assert.ok(queries.length <= 2, "The final page must not be requested again");
    return [[{ metadata: { name: `chart-photos/t/s/c/${id}`, generation: "9007199254740993",
      timeCreated: "2026-10-13T12:00:00Z", metadata: { uploadId: marker } } }], queries.length === 1 ? { pageToken: "next-page-token" } : null];
  } })) items.push(item);
  assert.deepEqual(queries.map((query) => query.pageToken), [undefined, "next-page-token"]);
  assert.deepEqual(items, [object("first"), object("second")]);
});
