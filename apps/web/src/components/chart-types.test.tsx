import assert from "node:assert/strict";
import test from "node:test";
import { chartDateInput, chartInitialValues, chartPayload, chartPhotoMetadata, chartPhotoMetadataHeader, type ChartFormValues } from "./chart-types";

const values: ChartFormValues = {
  treatmentAt: "2026-10-13T09:15", bodyParts: "顔、腕, 顔\n背中", performedServiceDetail: "施術記録",
  machine: "機器A", outputJ: "8.5 J / 左右", pulseWidth: "10 ms",
  skinObservations: "肌の観察", productsMaterials: "使用製品", aftercareNotes: "記録", nextVisitPlan: "次回予定"
};

test("JST表示の施術日時をUTC保存し、UTCから同じ表示へ戻す", () => {
  const payload = chartPayload(values, "Asia/Tokyo");
  assert.equal(payload.treatmentAt, "2026-10-13T00:15:00.000Z");
  assert.equal(chartDateInput(payload.treatmentAt, "Asia/Tokyo"), values.treatmentAt);
});

test("端末のタイムゾーンに依存せず店舗のタイムゾーンで日時を変換する", () => {
  assert.equal(chartPayload(values, "America/New_York").treatmentAt, "2026-10-13T13:15:00.000Z");
  assert.equal(chartInitialValues(undefined, "2026-10-13T13:15:00.000Z", "America/New_York").treatmentAt, values.treatmentAt);
});

test("夏時間開始時の存在しないローカル日時は保存しない", () => {
  assert.throws(() => chartPayload({ ...values, treatmentAt: "2026-03-08T02:30" }, "America/New_York"), /有効な施術日時/);
});

test("空欄や存在しない日付は別日に丸めずエラーにする", () => {
  assert.throws(() => chartPayload({ ...values, treatmentAt: "" }), /施術日時/);
  assert.throws(() => chartPayload({ ...values, treatmentAt: "2026-02-31T09:15" }), /有効な施術日時/);
});

test("施術部位は区切り記号を扱い、空欄・重複を取り除く", () => {
  assert.deepEqual(chartPayload(values).bodyParts, ["顔", "腕", "背中"]);
  assert.deepEqual(chartPayload({ ...values, bodyParts: "、 ,\n" }).bodyParts, []);
});

test("機器の設定値と記録文章を数値化・推奨値変換しない", () => {
  const payload = chartPayload(values);
  assert.equal(payload.outputJ, values.outputJ);
  assert.equal(payload.pulseWidth, values.pulseWidth);
  assert.equal(payload.skinObservations, values.skinObservations);
  assert.equal(payload.aftercareNotes, values.aftercareNotes);
});


test("写真の撮影日時は店舗の時刻で保存し、未入力は撮影時刻を推測しない", () => {
  assert.deepEqual(chartPhotoMetadata({ bodyPart: "  両わき  ", note: " 毛量が減少\n赤みなし ", capturedAt: "2026-10-13T09:15" }), {
    bodyPart: "両わき", note: "毛量が減少\n赤みなし", capturedAt: "2026-10-13T00:15:00.000Z"
  });
  assert.deepEqual(chartPhotoMetadata({ bodyPart: " ", note: "", capturedAt: "" }), {});
  assert.throws(() => chartPhotoMetadata({ bodyPart: "", note: "", capturedAt: "2026-02-31T09:15" }), /有効な撮影日時/);
  assert.throws(() => chartPhotoMetadata({ bodyPart: "", note: "", capturedAt: "2026-03-08T02:30" }, "America/New_York"), /有効な撮影日時/);
});

test("写真の日本語・絵文字メモをURLに含めずASCIIのヘッダーで欠損なく転送できる", () => {
  const metadata = chartPhotoMetadata({ bodyPart: "右ひざ下", note: "赤みなし。前回より減少。🌸", capturedAt: "2026-10-13T09:15" });
  const header = chartPhotoMetadataHeader(metadata);
  assert.match(header, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64").toString("utf8")), metadata);
  const longest = chartPhotoMetadata({ bodyPart: "部".repeat(120), note: "肌".repeat(1000), capturedAt: "2026-10-13T09:15" });
  assert.ok(chartPhotoMetadataHeader(longest).length < 7000);
  assert.throws(() => chartPhotoMetadata({ bodyPart: "部".repeat(121), note: "", capturedAt: "" }), /120文字/);
  assert.throws(() => chartPhotoMetadata({ bodyPart: "", note: "肌".repeat(1001), capturedAt: "" }), /1000文字/);
});
