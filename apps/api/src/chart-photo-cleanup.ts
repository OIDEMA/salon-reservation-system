import { prisma } from "./database.js";
import { chartPhotoObjectReference, chartPhotoStorage, type ChartPhotoStorage } from "./chart-photo-storage.js";

// Photos never acquire new references once all revision links have been removed.
// Retaining a tombstone until Cloud Storage confirms deletion makes failed cleanup retryable.
export async function cleanupUnreferencedChartPhotos(
  scope: { tenantId: string; salonId: string }, storage: ChartPhotoStorage = chartPhotoStorage, limit = 20
) {
  const where = { ...scope, storageDeletePendingAt: { not: null }, revisionLinks: { none: {} } };
  const rows = await prisma.treatmentChartPhoto.findMany({
    where, orderBy: { storageDeletePendingAt: "asc" }, take: Math.min(Math.max(limit, 1), 100),
    select: { id: true, storageBucket: true, storagePath: true, storageGeneration: true }
  });
  let removed = 0;
  let pending = 0;
  for (const row of rows) {
    try {
      const object = chartPhotoObjectReference(row);
      if (object) await storage.remove(object);
      const deleted = await prisma.treatmentChartPhoto.deleteMany({ where: { ...where, ...row } });
      removed += deleted.count;
    } catch {
      // Avoid logging clinical contents or object paths. A later call can retry this row.
      pending++;
    }
  }
  return { removed, pending };
}
