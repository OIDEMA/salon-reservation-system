export type ChartStatus = "DRAFT" | "FINALIZED";
export type ChartPhoto = {
  id: string; phase: "BEFORE" | "AFTER"; mimeType: string;
  width: number; height: number; byteSize: number; createdAt: string;
  bodyPart?: string | null; note?: string | null; capturedAt?: string | null;
};
export type ChartPhotoMetadata = { bodyPart?: string; note?: string; capturedAt?: string };

export type ChartRevision = {
  id: string; revisionNumber: number; status: ChartStatus;
  treatmentAt: string; bodyParts: string[]; performedServiceDetail: string;
  machine: string; outputJ: string; pulseWidth: string; skinObservations: string;
  productsMaterials: string; aftercareNotes: string; nextVisitPlan: string;
  amendmentReason: string | null; createdAt: string; updatedAt: string;
  finalizedAt: string | null; createdByName: string | null;
  finalizedByName: string | null; photos: ChartPhoto[];
};
export type ChartSummary = {
  id: string; reservationId: string; customerId: string; customerName: string;
  staffId: string | null; staffName: string | null; serviceName: string;
  startsAt: string; endsAt: string; treatmentAt: string;
  currentRevisionNumber: number; version: number; status: ChartStatus;
  updatedAt: string; photoCount: number; timezone: string;
};
export type ChartReservation = {
  id: string; startsAt: string; endsAt: string; status: string;
  customer: { id: string; name: string };
  staff: { id: string; name: string } | null;
  service: { id: string; name: string }; chartId?: string | null; timezone: string;
};
export type ChartDetail = ChartSummary & {
  reservation: Omit<ChartReservation, "chartId" | "timezone">; revisions: ChartRevision[];
};
export type ChartFormValues = {
  treatmentAt: string; bodyParts: string; performedServiceDetail: string;
  machine: string; outputJ: string; pulseWidth: string; skinObservations: string;
  productsMaterials: string; aftercareNotes: string; nextVisitPlan: string;
};

function chartFormatter(timezone: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
}

export function chartDate(value: string, timezone = "Asia/Tokyo") {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : chartFormatter(timezone).format(date);
}

export function chartDateInput(value: string, timezone = "Asia/Tokyo") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(chartFormatter(timezone).formatToParts(date).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function chartInitialValues(revision?: ChartRevision, treatmentAt?: string, timezone = "Asia/Tokyo"): ChartFormValues {
  return {
    treatmentAt: chartDateInput(revision?.treatmentAt ?? treatmentAt ?? new Date().toISOString(), timezone),
    bodyParts: revision?.bodyParts.join("、") ?? "",
    performedServiceDetail: revision?.performedServiceDetail ?? "",
    machine: revision?.machine ?? "", outputJ: revision?.outputJ ?? "",
    pulseWidth: revision?.pulseWidth ?? "", skinObservations: revision?.skinObservations ?? "",
    productsMaterials: revision?.productsMaterials ?? "", aftercareNotes: revision?.aftercareNotes ?? "",
    nextVisitPlan: revision?.nextVisitPlan ?? ""
  };
}

function localDateToIso(value: string, timezone: string, label: string) {
  const desired = Date.parse(value + ":00Z");
  if (!Number.isFinite(desired)) throw new Error(`${label}を入力してください。`);
  let timestamp = desired;
  for (let attempt = 0; attempt < 4; attempt++) {
    const represented = Date.parse(chartDateInput(new Date(timestamp).toISOString(), timezone) + ":00Z");
    timestamp += desired - represented;
  }
  const result = new Date(timestamp).toISOString();
  if (chartDateInput(result, timezone) !== value) throw new Error(`店舗のタイムゾーンで有効な${label}を入力してください。`);
  return result;
}

export function chartPhotoMetadata(values: { bodyPart: string; note: string; capturedAt: string }, timezone = "Asia/Tokyo"): ChartPhotoMetadata {
  const bodyPart = values.bodyPart.trim();
  const note = values.note.trim();
  if (bodyPart.length > 120) throw new Error("撮影部位は120文字以内で入力してください。");
  if (note.length > 1000) throw new Error("脱毛の状態は1000文字以内で入力してください。");
  return {
    ...(bodyPart ? { bodyPart } : {}), ...(note ? { note } : {}),
    ...(values.capturedAt ? { capturedAt: localDateToIso(values.capturedAt, timezone, "撮影日時") } : {})
  };
}

export function chartPhotoMetadataHeader(metadata: ChartPhotoMetadata) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(metadata))));
}

export function chartPayload(values: ChartFormValues, timezone = "Asia/Tokyo") {
  return {
    ...values, treatmentAt: localDateToIso(values.treatmentAt, timezone, "施術日時"),
    bodyParts: [...new Set(values.bodyParts.split(/[,、\n]/).map((part) => part.trim()).filter(Boolean))]
  };
}

export async function chartResponseError(response: Response) {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? `処理に失敗しました（${response.status}）。`;
}
