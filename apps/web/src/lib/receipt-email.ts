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
};
export type ReceiptEmailContext = {
  defaultRecipientEmail: string;
  defaultRecipientName: string;
  defaultDescription: string;
  history: ReceiptEmailRecord[];
};
export type ReceiptEmailFields = {
  version: number;
  recipientEmail: string;
  recipientName: string;
  description: string;
};
export type ReceiptEmailPreview = { subject: string; text: string; fields: Readonly<ReceiptEmailFields> };
export type ReceiptEmailAttempt = { requestId: string; fields: Readonly<ReceiptEmailFields> };

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
    && (record.sentAt === null || typeof record.sentAt === "string") && (record.lastErrorCode === null || typeof record.lastErrorCode === "string");
}

function invalidResponse(): never { throw new ReceiptEmailRequestError("サーバーからの結果を確認できませんでした。"); }

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
  const result = await receiptRequest<ReceiptEmailContext>(receiptPath(slug, checkoutId), undefined, signal);
  if (![result.defaultRecipientEmail, result.defaultRecipientName, result.defaultDescription].every((value) => typeof value === "string") || !Array.isArray(result.history) || !result.history.every(isReceiptRecord)) invalidResponse();
  return result;
}

export async function prepareReceiptEmail(slug: string, checkoutId: string, input: ReceiptEmailFields, signal?: AbortSignal): Promise<ReceiptEmailPreview> {
  const fields = Object.freeze({ version: input.version, recipientEmail: input.recipientEmail.trim(), recipientName: input.recipientName.trim(), description: input.description.trim() });
  const result = await receiptRequest<{ subject: string; text: string }>(`${receiptPath(slug, checkoutId)}/preview`, fields, signal);
  if (typeof result.subject !== "string" || typeof result.text !== "string") invalidResponse();
  return { ...result, fields };
}

export function createReceiptEmailAttempt(preview: ReceiptEmailPreview, requestId: string): ReceiptEmailAttempt {
  return Object.freeze({ requestId, fields: Object.freeze({ ...preview.fields }) });
}

export async function sendReceiptEmail(slug: string, checkoutId: string, attempt: ReceiptEmailAttempt) {
  const result = await receiptRequest<ReceiptEmailRecord>(receiptPath(slug, checkoutId), { ...attempt.fields, requestId: attempt.requestId });
  if (!isReceiptRecord(result)) invalidResponse();
  return result;
}
