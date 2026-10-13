import assert from "node:assert/strict";
import { test } from "node:test";
import { createChartPhotoStorage, chartPhotoObjectReference, type ChartPhotoStorageClient } from "./chart-photo-storage.js";
import { ChartError } from "./chart-domain.js";
import { getStorage } from "firebase-admin/storage";

const input = {
  tenantId: "tenant-1", salonId: "salon-1", chartId: "chart-1", photoId: "photo-1",
  data: Buffer.from("normalized image"), mimeType: "image/png"
};

function harness() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let uploadId = "";
  let generation = "1700000000000001";
  let fail = false;
  let failMetadata = false;
  const client: ChartPhotoStorageClient = { bucket(name) {
    calls.push({ method: "bucket", args: [name] });
    return { file(path, options) {
      calls.push({ method: "file", args: [path, options] });
      return {
        async save(data, options) {
          calls.push({ method: "save", args: [data, options] });
          uploadId = options.metadata.metadata.uploadId;
          if (fail) throw new Error("sensitive cloud diagnostics");
        },
        async getMetadata() {
          if (failMetadata) throw new Error("lost metadata response");
          return [{ generation, metadata: { uploadId } }];
        },
        async download(options) {
          calls.push({ method: "download", args: [options] });
          if (fail) throw new Error("private cloud object");
          return [input.data];
        },
        async delete(options) {
          calls.push({ method: "delete", args: [options] });
          if (fail) throw new Error("private cloud object");
        }
      };
    } };
  } };
  return { calls, client, setFail: () => { fail = true; }, setFailMetadata: () => { failMetadata = true; }, setGeneration: (value: string) => { generation = value; } };
}

test("cloud upload is create-only, checked, private and free of customer metadata", async () => {
  const h = harness();
  const storage = createChartPhotoStorage({ bucket: () => "private-chart-photos", client: () => h.client });
  const object = await storage.put(input);
  assert.deepEqual(object, {
    storageBucket: "private-chart-photos", storagePath: "chart-photos/tenant-1/salon-1/chart-1/photo-1", storageGeneration: "1700000000000001"
  });
  const save = h.calls.find((call) => call.method === "save")!;
  assert.equal(save.args[0], input.data);
  const options = save.args[1] as Record<string, unknown>;
  assert.deepEqual(options.preconditionOpts, { ifGenerationMatch: 0 });
  assert.equal(options.validation, "crc32c");
  assert.equal(options.resumable, false);
  assert.deepEqual(Object.keys((options.metadata as { metadata: object }).metadata), ["uploadId"]);
  assert.equal(JSON.stringify(options).includes("firebaseStorageDownloadTokens"), false);
  assert.equal(JSON.stringify(options).includes("publicRead"), false);
  assert.equal((options.metadata as { cacheControl: string }).cacheControl, "private, no-store");
});

test("read and deletion are bound to a generation the SDK can represent exactly", async () => {
  const h = harness();
  const storage = createChartPhotoStorage({ bucket: () => "private-chart-photos", client: () => h.client });
  h.setGeneration("1700000000000001");
  const object = await storage.put(input);
  assert.equal((await storage.read(object)).toString(), input.data.toString());
  await storage.remove(object);
  const pinnedFiles = h.calls.filter((call) => call.method === "file").slice(1);
  assert.deepEqual(pinnedFiles.map((call) => call.args[1]), [{ generation: "1700000000000001" }, { generation: "1700000000000001" }]);
  assert.deepEqual(h.calls.find((call) => call.method === "delete")!.args, [{ ifGenerationMatch: "1700000000000001", ignoreNotFound: true }]);
});

test("unsafe integer generations fail closed before the SDK can round them", async () => {
  const h = harness();
  const storage = createChartPhotoStorage({ bucket: () => "private-chart-photos", client: () => h.client });
  const generation = "1700000000000001";
  // The real SDK constructor coerces generations to Number; this assertion uses no network.
  const file = getStorage().bucket("private-chart-photos").file("chart-photos/t/s/c/p", { generation });
  assert.equal(String(file.generation), generation);
  await assert.rejects(storage.read({ storageBucket: "private-chart-photos", storagePath: "chart-photos/t/s/c/p", storageGeneration: "9007199254740993" }), ChartError);
  await assert.rejects(storage.remove({ storageBucket: "private-chart-photos", storagePath: "chart-photos/t/s/c/p", storageGeneration: "9007199254740993" }), ChartError);
  assert.deepEqual(h.calls, []);
});

test("missing bucket fails closed and never writes bytes elsewhere", async () => {
  const h = harness();
  const storage = createChartPhotoStorage({ bucket: () => "", client: () => h.client });
  await assert.rejects(storage.put(input), (error) => error instanceof ChartError && error.code === "CHART_PHOTO_STORAGE_NOT_CONFIGURED");
  assert.deepEqual(h.calls, []);
});

test("unsafe paths, partial refs and invalid generations are rejected", async () => {
  const h = harness();
  const storage = createChartPhotoStorage({ bucket: () => "private-chart-photos", client: () => h.client });
  await assert.rejects(storage.put({ ...input, tenantId: "../tenant" }), ChartError);
  assert.equal(chartPhotoObjectReference({ storageBucket: null, storagePath: null, storageGeneration: null }), null);
  assert.throws(() => chartPhotoObjectReference({ storageBucket: "bucket", storagePath: null, storageGeneration: null }), ChartError);
  await assert.rejects(storage.read({ storageBucket: "bucket", storagePath: "other-prefix/key", storageGeneration: "1" }), ChartError);
  await assert.rejects(storage.remove({ storageBucket: "bucket", storagePath: "chart-photos/t/s/c/p", storageGeneration: "0" }), ChartError);
  assert.deepEqual(h.calls, []);
});

test("cloud failure exposes only a safe unavailable error and never deletes an unknown upload", async () => {
  const h = harness();
  h.setFail();
  const storage = createChartPhotoStorage({ bucket: () => "private-chart-photos", client: () => h.client });
  await assert.rejects(storage.put(input), (error) => error instanceof ChartError && error.statusCode === 503 && !error.message.includes("sensitive"));
  assert.equal(h.calls.some((call) => call.method === "delete"), false);
});


test("lost metadata response never guesses a generation or deletes the uploaded object", async () => {
  const h = harness();
  h.setFailMetadata();
  const storage = createChartPhotoStorage({ bucket: () => "private-chart-photos", client: () => h.client });
  await assert.rejects(storage.put(input), (error) => error instanceof ChartError && error.statusCode === 503);
  assert.equal(h.calls.filter((call) => call.method === "save").length, 1);
  assert.equal(h.calls.some((call) => call.method === "delete"), false);
});
