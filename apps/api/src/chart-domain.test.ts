import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  assertChartDraft, assertChartFinalizable, assertChartVersion, ChartError,
  chartAmendSchema, chartCreateSchema, chartFieldData, MAX_CHART_PHOTO_BYTES, normalizeChartPhoto
} from "./chart-domain.js";

test("chart payload preserves text settings and rejects client-owned identity", () => {
  const fields = chartCreateSchema.parse({ reservationId: "reservation", treatmentAt: "2026-10-13T11:30:00+09:00", bodyParts: ["腕", "腕"], outputJ: "部位A: 12J / 部位B: 10J", pulseWidth: "スタッフ記録: 50ms" });
  const { reservationId: _reservationId, ...content } = fields;
  const data = chartFieldData(content);
  assert.equal(data.treatmentAt.toISOString(), "2026-10-13T02:30:00.000Z");
  assert.equal(data.outputJ, "部位A: 12J / 部位B: 10J");
  assert.equal(data.pulseWidth, "スタッフ記録: 50ms");
  assert.deepEqual(data.bodyParts, ["腕"]);
  assert.equal(chartCreateSchema.safeParse({ ...fields, tenantId: "other" }).success, false);
  assert.equal(chartCreateSchema.safeParse({ ...fields, customerId: "other" }).success, false);
  assert.equal(chartCreateSchema.safeParse({ ...fields, staffId: "other" }).success, false);
});

test("finalization requires treatment content; immutable and concurrent updates reject", () => {
  assert.throws(() => assertChartFinalizable({ performedServiceDetail: "  \n" }), (error) => error instanceof ChartError && error.code === "CHART_CONTENT_REQUIRED");
  assert.doesNotThrow(() => assertChartFinalizable({ performedServiceDetail: "腕の施術を実施" }));
  assert.throws(() => assertChartDraft("FINALIZED"), (error) => error instanceof ChartError && error.statusCode === 409);
  assert.throws(() => assertChartVersion(3, 2), (error) => error instanceof ChartError && error.code === "CHART_CONFLICT");
  assert.equal(chartAmendSchema.safeParse({ expectedVersion: 3, reason: "　" }).success, false);
  assert.equal(chartAmendSchema.parse({ expectedVersion: 3, reason: " 記録の追記 " }).reason, "記録の追記");
});

for (const format of ["jpeg", "png", "webp"] as const) {
  test(`photo validation decodes ${format} and removes extraneous trailing bytes`, async () => {
    const source = await sharp({ create: { width: 24, height: 18, channels: 3, background: "#cfc3bc" } }).toFormat(format).toBuffer();
    const input = Buffer.concat([source, Buffer.from("private trailing payload")]);
    const result = await normalizeChartPhoto(input, `image/${format}`);
    assert.equal(result.width, 24);
    assert.equal(result.height, 18);
    assert.equal(result.mimeType, `image/${format}`);
    assert.equal(result.byteSize, result.data.length);
    assert.equal(result.data.includes(Buffer.from("private trailing payload")), false);
    assert.equal((await sharp(result.data).metadata()).format, format);
  });
}

test("photo validation strips EXIF and applies camera orientation", async () => {
  const source = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#ded1c9" } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  assert.ok((await sharp(source).metadata()).exif);
  const result = await normalizeChartPhoto(source, "image/jpeg");
  assert.equal(result.width, 10);
  assert.equal(result.height, 20);
  const metadata = await sharp(result.data).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.orientation, undefined);
});

test("photo validation rejects mismatched MIME, SVG, corrupted bytes and oversize inputs", async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(normalizeChartPhoto(png, "image/jpeg"), (error) => error instanceof ChartError && error.code === "CHART_PHOTO_INVALID");
  await assert.rejects(normalizeChartPhoto(Buffer.from("<svg/>"), "image/svg+xml"), (error) => error instanceof ChartError && error.statusCode === 415);
  await assert.rejects(normalizeChartPhoto(Buffer.from("not an image"), "image/png"), (error) => error instanceof ChartError && error.code === "CHART_PHOTO_INVALID");
  await assert.rejects(normalizeChartPhoto(png.subarray(0, 40), "image/png"), (error) => error instanceof ChartError && error.code === "CHART_PHOTO_INVALID");
  await assert.rejects(normalizeChartPhoto(Buffer.alloc(MAX_CHART_PHOTO_BYTES + 1), "image/png"), (error) => error instanceof ChartError && error.statusCode === 413);
});

test("APNG animation control is rejected even when the decoder reports no page count", async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).png().toBuffer();
  function crc32(bytes: Buffer) {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  }
  function chunk(type: string, data: Buffer) {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    result.write(type, 4, 4, "ascii");
    data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
    return result;
  }
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(1, 0);
  const frameControl = Buffer.alloc(26);
  frameControl.writeUInt32BE(4, 4);
  frameControl.writeUInt32BE(4, 8);
  frameControl.writeUInt16BE(1, 20);
  frameControl.writeUInt16BE(10, 22);
  const animated = Buffer.concat([png.subarray(0, 33), chunk("acTL", animationControl), chunk("fcTL", frameControl), png.subarray(33)]);
  // Sharp can decode this container; rejecting corrupt image bytes would not catch the regression.
  assert.equal((await sharp(animated).metadata()).format, "png");
  await assert.rejects(normalizeChartPhoto(animated, "image/png"), (error) => error instanceof ChartError && error.code === "CHART_PHOTO_INVALID");
  const ordinaryWithText = Buffer.concat([png.subarray(0, 33), chunk("tEXt", Buffer.from("note\0contains acTL as ordinary metadata")), png.subarray(33)]);
  assert.equal((await normalizeChartPhoto(ordinaryWithText, "image/png")).width, 4);
});
