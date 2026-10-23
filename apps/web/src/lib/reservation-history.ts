import type { ReservationHistoryImportFile, ReservationHistoryImportProgress, ReservationHistoryPage } from "./admin-types";
import { tenantApiPath } from "./tenant-routing";

export type ReservationHistoryFilters = { q: string; from: string; to: string; sourceStatus: string };
export const emptyHistoryFilters: ReservationHistoryFilters = { q: "", from: "", to: "", sourceStatus: "" };

export function reservationHistoryQuery(page = 1, filters: ReservationHistoryFilters = emptyHistoryFilters) {
  const query = new URLSearchParams({ page: String(page), pageSize: "50" });
  if (filters.q.trim()) query.set("q", filters.q.trim());
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.sourceStatus) query.set("sourceStatus", filters.sourceStatus);
  return query;
}

async function historyResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message ?? `処理に失敗しました（${response.status}）。`);
  return body as T;
}

export function requestReservationHistoryPage(tenantSlug: string, page: number, filters: ReservationHistoryFilters, signal?: AbortSignal) {
  return fetch(`${tenantApiPath(tenantSlug, "/admin/reservation-history/page")}?${reservationHistoryQuery(page, filters)}`, {
    cache: "no-store", signal
  }).then(historyResponse<ReservationHistoryPage>);
}

export function historyDate(value: string | null, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "未登録";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未登録";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...options
  }).format(date);
}

export function historyAmount(value: number | null) {
  return value === null ? "未登録" : new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value);
}

export function validateHistoryImportPreview(value: unknown): ReservationHistoryImportFile {
  const data = value as Partial<ReservationHistoryImportFile> | null;
  const validDate = (date: unknown) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(`${date}T00:00:00+09:00`)) && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(`${date}T00:00:00+09:00`)) === date;
  if (!data || data.version !== 1 || data.source !== "SALONBOARD" || data.sourceStoreId !== "H000551123" ||
    !Array.isArray(data.records) || !Number.isInteger(data.expectedCount) || !data.expectedCount ||
    data.expectedCount < 1 || data.expectedCount > 10000 || data.records.length !== data.expectedCount ||
    !validDate(data.periodFrom) || !validDate(data.periodTo) || data.periodFrom! >= data.periodTo! ||
    typeof data.capturedAt !== "string" || Number.isNaN(Date.parse(data.capturedAt))) {
    throw new Error("ミスミセス高松店の取込ファイル・対象期間・件数を確認してください。");
  }
  return data as ReservationHistoryImportFile;
}

export async function importReservationHistory(tenantSlug: string, document: ReservationHistoryImportFile, {
  signal, onProgress
}: { signal: AbortSignal; onProgress: (progress: ReservationHistoryImportProgress) => void }) {
  const path = tenantApiPath(tenantSlug, "/admin/history-imports/salonboard");
  const options = { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store" as const, signal };
  // Prepare the complete file again on retries; the API returns the same manifest
  // and its committed offsets, including a chunk whose response was interrupted.
  let progress = await historyResponse<ReservationHistoryImportProgress>(await fetch(`${path}/prepare`, { ...options, body: JSON.stringify(document) }));
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (progress.chunkSize !== 50 || progress.expectedCount !== document.expectedCount) throw new Error("取込ファイルの登録件数を確認できませんでした。");
  onProgress(progress);
  for (let offset = 0; offset < document.records.length; offset += progress.chunkSize) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (progress.processedOffsets.includes(offset)) continue;
    progress = await historyResponse<ReservationHistoryImportProgress>(await fetch(`${path}/${encodeURIComponent(progress.id)}/chunks`, {
      ...options, body: JSON.stringify({ offset, records: document.records.slice(offset, offset + progress.chunkSize) })
    }));
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    onProgress(progress);
  }
  if (!progress.completed) throw new Error("一部の登録が未完了です。同じファイルで登録を再開してください。");
  return progress;
}
