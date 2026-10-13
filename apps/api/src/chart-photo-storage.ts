import { randomUUID } from "node:crypto";
import { getStorage } from "firebase-admin/storage";
import "./auth.js";
import { ChartError } from "./chart-domain.js";

export type ChartPhotoObject = { storageBucket: string; storagePath: string; storageGeneration: string };
export type ChartPhotoObjectInput = {
  tenantId: string; salonId: string; chartId: string; photoId: string; data: Buffer; mimeType: string;
};
export interface ChartPhotoStorage {
  put(input: ChartPhotoObjectInput): Promise<ChartPhotoObject>;
  read(object: ChartPhotoObject): Promise<Buffer>;
  remove(object: ChartPhotoObject): Promise<void>;
}

// Small SDK boundary permits deterministic tests without credentials or network access.
type FileHandle = {
  save(data: Buffer, options: {
    resumable: false; validation: "crc32c"; preconditionOpts: { ifGenerationMatch: 0 };
    metadata: { contentType: string; cacheControl: string; contentDisposition: string; metadata: { uploadId: string } };
  }): Promise<unknown>;
  getMetadata(): Promise<[{ generation?: string | number; metadata?: Record<string, unknown> }, ...unknown[]]>;
  download(options: { validation: "crc32c" }): Promise<[Buffer, ...unknown[]]>;
  delete(options: { ifGenerationMatch: string; ignoreNotFound: true }): Promise<unknown>;
};
export type ChartPhotoStorageClient = {
  bucket(name: string): { file(path: string, options?: { generation: string }): FileHandle };
};

function unavailable() {
  return new ChartError("CHART_PHOTO_STORAGE_UNAVAILABLE", "写真の保存先に接続できません。時間をおいて再度お試しください。", 503);
}

function assertObject(object: ChartPhotoObject) {
  if (!object.storageBucket || !/^chart-photos\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(object.storagePath) ||
    !/^[1-9][0-9]*$/.test(object.storageGeneration) || !Number.isSafeInteger(Number(object.storageGeneration))) throw unavailable();
}

export function chartPhotoObjectReference(value: {
  storageBucket: string | null; storagePath: string | null; storageGeneration: string | null;
}): ChartPhotoObject | null {
  if (!value.storageBucket && !value.storagePath && !value.storageGeneration) return null;
  if (!value.storageBucket || !value.storagePath || !value.storageGeneration) throw unavailable();
  const object = { storageBucket: value.storageBucket, storagePath: value.storagePath, storageGeneration: value.storageGeneration };
  assertObject(object);
  return object;
}

export function createChartPhotoStorage(options: {
  bucket?: () => string | undefined; client?: () => ChartPhotoStorageClient;
} = {}): ChartPhotoStorage {
  const client = options.client ?? (() => getStorage());
  return {
    async put(input) {
      const storageBucket = (options.bucket?.() ?? process.env.CHART_PHOTOS_BUCKET)?.trim();
      if (!storageBucket || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(storageBucket)) {
        throw new ChartError("CHART_PHOTO_STORAGE_NOT_CONFIGURED", "写真の保存先が未設定です。管理者にお問い合わせください。", 503);
      }
      const segments = [input.tenantId, input.salonId, input.chartId, input.photoId];
      if (segments.some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment))) throw unavailable();
      const storagePath = `chart-photos/${segments.join("/")}`;
      const uploadId = randomUUID();
      try {
        const file = client().bucket(storageBucket).file(storagePath);
        await file.save(input.data, {
          resumable: false, validation: "crc32c", preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType: input.mimeType, cacheControl: "private, no-store", contentDisposition: "inline",
            metadata: { uploadId }
          }
        });
        const [metadata] = await file.getMetadata();
        // The UUID path and upload marker prevent adopting another object's generation.
        if (metadata.metadata?.uploadId !== uploadId) throw unavailable();
        const result = { storageBucket, storagePath, storageGeneration: String(metadata.generation ?? "") };
        assertObject(result);
        return result;
      } catch {
        // A failed upload response can be ambiguous. Never delete an unknown generation.
        throw unavailable();
      }
    },
    async read(object) {
      assertObject(object);
      try {
        const [bytes] = await client().bucket(object.storageBucket).file(object.storagePath, { generation: object.storageGeneration }).download({ validation: "crc32c" });
        return bytes;
      } catch { throw unavailable(); }
    },
    async remove(object) {
      assertObject(object);
      try {
        await client().bucket(object.storageBucket).file(object.storagePath, { generation: object.storageGeneration })
          .delete({ ifGenerationMatch: object.storageGeneration, ignoreNotFound: true });
      } catch { throw unavailable(); }
    }
  };
}

export const chartPhotoStorage = createChartPhotoStorage();
