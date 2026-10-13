import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This utility only inventories metadata and database references. Its dependencies
// deliberately expose no object download, mutation or deletion methods.
export type ChartPhotoInventoryItem = {
  name?: unknown; generation?: unknown; timeCreated?: unknown; uploadId?: unknown;
};
export type ChartPhotoInventoryBucket = {
  getFiles(options: { prefix: string; versions: true; autoPaginate: false; maxResults: number; pageToken?: string }): Promise<[
    Array<{ metadata: { name?: unknown; generation?: unknown; timeCreated?: unknown; metadata?: { uploadId?: unknown } } }>,
    { pageToken?: string } | null | undefined,
    ...unknown[]
  ]>;
};

export async function* chartPhotoStorageInventory(bucket: ChartPhotoInventoryBucket): AsyncIterable<ChartPhotoInventoryItem> {
  let pageToken: string | undefined;
  do {
    const [files, next] = await bucket.getFiles({
      prefix: "chart-photos/", versions: true, autoPaginate: false, maxResults: 500,
      ...(pageToken ? { pageToken } : {})
    });
    for (const file of files) {
      // The raw metadata preserves integer strings; File.generation converts to Number.
      yield { name: file.metadata.name, generation: file.metadata.generation,
        timeCreated: file.metadata.timeCreated, uploadId: file.metadata.metadata?.uploadId };
    }
    // The SDK returns null after the last page, despite its narrower declaration.
    pageToken = next?.pageToken;
  } while (pageToken);
}

export type ChartPhotoAuditReference = {
  id: string; tenantId: string; salonId: string; chartId: string;
  storageBucket: string | null; storagePath: string | null; storageGeneration: string | null;
  pendingDeletion: boolean; revisionLinkCount: number;
};
export type ChartPhotoAuditDependencies = {
  inventory(bucket: string): AsyncIterable<ChartPhotoInventoryItem>;
  references(object: { bucket: string; path: string; photoId: string }): Promise<ChartPhotoAuditReference[]>;
};
export type ChartPhotoAuditOptions = {
  bucket: string; configuredBucket: string | undefined; olderThanHours: number; now?: Date;
};
type AuditReason = "NO_DATABASE_RECORD" | "LOCATION_OR_SCOPE_MISMATCH" | "GENERATION_MISMATCH" |
  "PENDING_DELETION" | "UNLINKED_DATABASE_PHOTO" | "PENDING_BUT_REFERENCED";

const objectPath = /^chart-photos\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/;
const uploadMarker = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateOptions(options: ChartPhotoAuditOptions) {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(options.bucket) || options.bucket !== options.configuredBucket?.trim()) {
    throw new Error("--bucket must explicitly match CHART_PHOTOS_BUCKET.");
  }
  if (!Number.isFinite(options.olderThanHours) || options.olderThanHours < 24) {
    throw new Error("--older-than-hours must be at least 24.");
  }
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.olderThanHours * 3_600_000);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(cutoff.getTime())) throw new Error("Invalid audit date range.");
  return cutoff;
}

function exactGeneration(value: unknown) {
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

export async function auditChartPhotoStorage(options: ChartPhotoAuditOptions, dependencies: ChartPhotoAuditDependencies) {
  const cutoff = validateOptions(options);
  const report = {
    readOnly: true as const, bucket: options.bucket, cutoff: cutoff.toISOString(),
    // Inventory/DB queries are not an atomic snapshot; findings are review candidates,
    // never proof that a photo can be removed. Verify the intended database first.
    manualReviewRequired: true as const,
    scanned: 0, referenced: 0, skippedRecent: 0, skippedUnrecognized: 0,
    findings: [] as Array<{
      reason: AuditReason; path: string; generation: string; createdAt: string;
      tenantId: string; salonId: string; chartId: string; photoId: string;
      databaseReferences: Array<{ id: string; generation: string | null; pendingDeletion: boolean; revisionLinkCount: number }>;
    }>
  };
  for await (const item of dependencies.inventory(options.bucket)) {
    report.scanned++;
    const match = typeof item.name === "string" ? objectPath.exec(item.name) : null;
    const generation = exactGeneration(item.generation);
    const created = typeof item.timeCreated === "string" ? new Date(item.timeCreated) : new Date(NaN);
    if (!match || !generation || !Number.isFinite(created.getTime()) || typeof item.uploadId !== "string" || !uploadMarker.test(item.uploadId)) {
      // Do not print unrecognized paths or arbitrary metadata: they may contain names/notes.
      report.skippedUnrecognized++;
      continue;
    }
    if (created.getTime() > cutoff.getTime()) { report.skippedRecent++; continue; }
    const [path, tenantId, salonId, chartId, photoId] = match;
    const references = await dependencies.references({ bucket: options.bucket, path, photoId });
    const sameLocation = references.filter((row) => row.storageBucket === options.bucket && row.storagePath === path &&
      row.tenantId === tenantId && row.salonId === salonId && row.chartId === chartId && row.id === photoId);
    const exact = sameLocation.filter((row) => row.storageGeneration === generation);
    let reason: AuditReason;
    if (!references.length) reason = "NO_DATABASE_RECORD";
    else if (!sameLocation.length || sameLocation.length !== references.length) reason = "LOCATION_OR_SCOPE_MISMATCH";
    else if (!exact.length) reason = "GENERATION_MISMATCH";
    else if (exact.some((row) => row.pendingDeletion && row.revisionLinkCount > 0)) reason = "PENDING_BUT_REFERENCED";
    else if (exact.some((row) => row.revisionLinkCount > 0)) { report.referenced++; continue; }
    else reason = exact.some((row) => row.pendingDeletion) ? "PENDING_DELETION" : "UNLINKED_DATABASE_PHOTO";
    report.findings.push({
      reason, path, generation, createdAt: created.toISOString(), tenantId, salonId, chartId, photoId,
      databaseReferences: references.map((row) => ({ id: row.id, generation: row.storageGeneration,
        pendingDeletion: row.pendingDeletion, revisionLinkCount: row.revisionLinkCount }))
    });
  }
  return report;
}

export function parseChartPhotoAuditArguments(args: string[], configuredBucket: string | undefined): ChartPhotoAuditOptions {
  const values = new Map<string, string>();
  if (args.length !== 4) throw new Error("Usage: --bucket BUCKET --older-than-hours HOURS (minimum 24).");
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!["--bucket", "--older-than-hours"].includes(key) || values.has(key) || !args[i + 1]) {
      throw new Error("Usage: --bucket BUCKET --older-than-hours HOURS (minimum 24).");
    }
    values.set(key, args[i + 1]);
  }
  const options = { bucket: values.get("--bucket")!, configuredBucket, olderThanHours: Number(values.get("--older-than-hours")) };
  validateOptions(options);
  return options;
}

async function main() {
  // Validate explicit scope before initializing cloud or database clients.
  const options = parseChartPhotoAuditArguments(process.argv.slice(2), process.env.CHART_PHOTOS_BUCKET);
  await import("../auth.js");
  const { getStorage } = await import("firebase-admin/storage");
  const { prisma } = await import("../database.js");
  try {
    const report = await auditChartPhotoStorage(options, {
      inventory(bucketName) { return chartPhotoStorageInventory(getStorage().bucket(bucketName)); },
      async references({ bucket, path, photoId }) {
        const rows = await prisma.treatmentChartPhoto.findMany({
          where: { OR: [{ id: photoId }, { storageBucket: bucket, storagePath: path }] },
          select: { id: true, tenantId: true, salonId: true, chartId: true, storageBucket: true, storagePath: true,
            storageGeneration: true, storageDeletePendingAt: true, _count: { select: { revisionLinks: true } } }
        });
        return rows.map(({ storageDeletePendingAt, _count, ...row }) => ({ ...row,
          pendingDeletion: storageDeletePendingAt !== null, revisionLinkCount: _count.revisionLinks }));
      }
    });
    console.log(JSON.stringify(report, null, 2));
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch {
    // SDK/Prisma diagnostics may contain storage paths or SQL values; do not echo them.
    console.error("Photo storage audit failed. Check the explicit bucket, age (minimum 24 hours), database target and read permissions. No data was changed.");
    process.exitCode = 1;
  }
}
