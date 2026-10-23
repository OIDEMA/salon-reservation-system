import { tenantApiPath } from "./tenant-routing";

export type ReceiptEmailStatus = "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "SKIPPED";
export type ReceiptEmailRecord = {
  id: string;
  recipientEmail: string;
  recipientName: string;
  description: string;
  status: ReceiptEmailStatus;
  createdAt: string;
  sentAt: string | null;
  lastErrorCode: string | null;
  format: "PDF" | "TEXT";
};
export type ReceiptIssuer = { name: string | null; registrationNumber: string | null; configured: boolean };
export type ReceiptEmailContext = {
  defaultRecipientEmail: string;
  defaultRecipientName: string;
  defaultDescription: string;
  history: ReceiptEmailRecord[];
  issuer: ReceiptIssuer;
};
export type ReceiptEmailFields = {
  version: number;
  recipientEmail: string;
  recipientName: string;
  description: string;
};
export type ReceiptEmailPdf = { fileName: string; contentBase64: string };
export type ReceiptEmailPreview = { subject: string; text: string; pdf: Readonly<ReceiptEmailPdf>; previewHash: string; fields: Readonly<ReceiptEmailFields> };
export type ReceiptEmailAttempt = { requestId: string; previewHash: string; fields: Readonly<ReceiptEmailFields> };
export const RECEIPT_PDF_MAX_BYTES = 6 * 1024 * 1024;

export const receiptEmailStatusLabels: Record<ReceiptEmailStatus, string> = {
  PENDING: "送信待ち", PROCESSING: "送信処理中", SENT: "メールサービス受付済み", FAILED: "送信失敗", SKIPPED: "送付中止"
};

export class ReceiptEmailRequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "ReceiptEmailRequestError"; }
}

function isReceiptRecord(value: unknown): value is ReceiptEmailRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["id", "recipientEmail", "recipientName", "description", "createdAt"].every((key) => typeof record[key] === "string")
    && typeof record.status === "string" && Object.hasOwn(receiptEmailStatusLabels, record.status)
    && (record.format === "PDF" || record.format === "TEXT")
    && (record.sentAt === null || typeof record.sentAt === "string") && (record.lastErrorCode === null || typeof record.lastErrorCode === "string");
}

function invalidResponse(): never { throw new ReceiptEmailRequestError("サーバーからの結果を確認できませんでした。"); }

export function parseReceiptEmailContext(value: unknown): ReceiptEmailContext {
  if (!value || typeof value !== "object") invalidResponse();
  const result = value as ReceiptEmailContext;
  if (![result.defaultRecipientEmail, result.defaultRecipientName, result.defaultDescription].every((entry) => typeof entry === "string") ||
    !Array.isArray(result.history) || !result.history.every(isReceiptRecord) || !result.issuer || typeof result.issuer !== "object") invalidResponse();
  const { name, registrationNumber, configured } = result.issuer;
  if (typeof configured !== "boolean" || !(name === null || typeof name === "string") ||
    !(registrationNumber === null || typeof registrationNumber === "string") ||
    configured && (!name?.trim() || !/^T\d{13}$/.test(registrationNumber ?? ""))) invalidResponse();
  return result;
}

function receiptPdfBytes(pdf: ReceiptEmailPdf): Uint8Array<ArrayBuffer> {
  if (!pdf || typeof pdf !== "object" || typeof pdf.fileName !== "string" || pdf.fileName.length > 160 ||
    !pdf.fileName.trim() || !/\.pdf$/i.test(pdf.fileName) || /[\x00-\x1f\x7f-\x9f/\\:*?"<>|\u2028\u2029]/.test(pdf.fileName) ||
    typeof pdf.contentBase64 !== "string") invalidResponse();
  const content = pdf.contentBase64;
  if (!content.length || content.length > Math.ceil(RECEIPT_PDF_MAX_BYTES / 3) * 4 || content.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) invalidResponse();
  let binary: string;
  try { binary = atob(content); } catch { invalidResponse(); }
  if (binary.length > RECEIPT_PDF_MAX_BYTES || btoa(binary) !== content || !binary.startsWith("%PDF-") || !/%%EOF[\t\n\r ]*$/.test(binary.slice(-1024))) invalidResponse();
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Each preview owns its URL and releases it on replacement, reset, or unmount. */
export function createReceiptPdfResource(pdf: ReceiptEmailPdf): { url: string; dispose: () => void } {
  const bytes = receiptPdfBytes(pdf);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  let disposed = false;
  return Object.freeze({ url, dispose() { if (!disposed) { disposed = true; URL.revokeObjectURL(url); } } });
}

function receiptPath(slug: string, checkoutId: string) {
  return tenantApiPath(slug, `/cash/checkouts/${encodeURIComponent(checkoutId)}/receipt-emails`);
}

async function receiptRequest<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new ReceiptEmailRequestError(typeof result?.message === "string" ? result.message : `領収書メールの処理に失敗しました (${response.status})`, response.status);
  if (!result || typeof result !== "object") invalidResponse();
  return result as T;
}

export async function loadReceiptEmails(slug: string, checkoutId: string, signal?: AbortSignal) {
  return parseReceiptEmailContext(await receiptRequest<unknown>(receiptPath(slug, checkoutId), undefined, signal));
}

export async function prepareReceiptEmail(slug: string, checkoutId: string, input: ReceiptEmailFields, signal?: AbortSignal): Promise<ReceiptEmailPreview> {
  const fields = Object.freeze({ version: input.version, recipientEmail: input.recipientEmail.trim(), recipientName: input.recipientName.trim(), description: input.description.trim() });
  const result = await receiptRequest<{ subject: string; text: string; pdf: ReceiptEmailPdf; previewHash: string }>(`${receiptPath(slug, checkoutId)}/preview`, fields, signal);
  if (typeof result.subject !== "string" || typeof result.text !== "string" || typeof result.previewHash !== "string" || !/^[a-f0-9]{64}$/.test(result.previewHash)) invalidResponse();
  receiptPdfBytes(result.pdf);
  return { subject: result.subject, text: result.text, pdf: Object.freeze({ fileName: result.pdf.fileName, contentBase64: result.pdf.contentBase64 }), previewHash: result.previewHash, fields };
}

export function createReceiptEmailAttempt(preview: ReceiptEmailPreview, requestId: string): ReceiptEmailAttempt {
  return Object.freeze({ requestId, previewHash: preview.previewHash, fields: Object.freeze({ ...preview.fields }) });
}

export async function sendReceiptEmail(slug: string, checkoutId: string, attempt: ReceiptEmailAttempt) {
  const result = await receiptRequest<ReceiptEmailRecord>(receiptPath(slug, checkoutId), { ...attempt.fields, requestId: attempt.requestId, previewHash: attempt.previewHash });
  if (!isReceiptRecord(result)) invalidResponse();
  return result;
}
