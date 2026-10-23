import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptEmail, ReceiptEmailHistory, ReceiptEmailPreviewContent } from "../src/components/receipt-email";
import { TenantProvider } from "../src/components/tenant-provider";
import type { CashCheckout } from "../src/components/cash-types";
import { createReceiptEmailAttempt, createReceiptPdfResource, loadReceiptEmails, parseReceiptEmailContext, prepareReceiptEmail, ReceiptEmailRequestError, sendReceiptEmail, type ReceiptEmailContext, type ReceiptEmailRecord } from "../src/lib/receipt-email";

const checkout: CashCheckout = {
  id: "checkout-test", reservationId: "reservation-test", status: "FINALIZED", version: 2,
  reservationSnapshot: { customerName: "領収書のお客様", serviceName: "施術", staffName: "担当", salonName: "店舗", startsAt: "2026-10-23T01:00:00Z" },
  items: [{ label: "施術", quantity: 1, unitPriceYen: 5500, discountYen: 0, taxRate: 10 }], payments: [{ method: "CASH", amountYen: 5500, reference: "" }],
  legacyPaymentStatus: "UNPAID", legacyPaidAcknowledged: false, subtotalYen: 5500, discountYen: 0, taxYen: 500, totalYen: 5500, cashYen: 5500, notes: "",
  taxBreakdown: [{ taxRate: 10, taxableTotalYen: 5500, taxYen: 500 }], finalizedAt: "2026-10-23T01:00:00Z", reversedAt: null, reversalReason: null
};
const record: ReceiptEmailRecord = { id: "mail-test", recipientEmail: "customer@example.test", recipientName: "領収書のお客様", description: "施術代として", format: "PDF", status: "PENDING", createdAt: "2026-10-23T01:00:00Z", sentAt: null, lastErrorCode: null };
const data: ReceiptEmailContext = { defaultRecipientEmail: record.recipientEmail, defaultRecipientName: record.recipientName, defaultDescription: record.description, issuer: { name: "店舗の発行事業者", registrationNumber: "T1234567890123", configured: true }, history: [record] };
const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii");
const pdf = { fileName: "領収書-checkout-test.pdf", contentBase64: pdfBytes.toString("base64") };
const previewHash = "a".repeat(64);
function render(children: ReactNode, permissions: string[]) {
  return renderToStaticMarkup(createElement(TenantProvider, { tenantSlug: "salon-test", memberships: [{ role: "STAFF", permissions, tenant: { id: "tenant-test", slug: "salon-test", name: "店舗", salons: [{ id: "salon-test", name: "店舗" }] } }], children }));
}

test("領収書メールは会計の閲覧権限を要求し、送付は確定権限を持つ確定会計だけに表示する", () => {
  assert.equal(render(createElement(ReceiptEmail, { checkout, initialData: data }), ["checkout.write"]), "");
  const readOnly = render(createElement(ReceiptEmail, { checkout, initialData: data }), ["checkout.read"]);
  assert.match(readOnly, /送付履歴/); assert.match(readOnly, /customer@example.test/);
  assert.doesNotMatch(readOnly, /type="email"|送付内容を確認|この内容で領収書を送付/);
  const reversed = render(createElement(ReceiptEmail, { checkout: { ...checkout, status: "REVERSED" }, initialData: data }), ["checkout.read", "checkout.write"]);
  assert.match(reversed, /全額取消済みの会計は領収書を送付できません/);
  assert.doesNotMatch(reversed, /type="email"|送付内容を確認/);
});

test("送付フォームは前回宛先と顧客宛名を初期表示し、最初の操作はプレビュー取得のみ", () => {
  const html = render(createElement(ReceiptEmail, { checkout, initialData: data }), ["checkout.read", "checkout.write"]);
  assert.match(html, /type="email"[^>]*value="customer@example.test"/);
  assert.match(html, /value="領収書のお客様"/); assert.match(html, /value="施術代として"/);
  assert.match(html, /送付内容を確認/);
  assert.doesNotMatch(html, /この内容で領収書を送付|type="checkbox"/);
  const empty = render(createElement(ReceiptEmail, { checkout, initialData: null, initialError: "取得失敗" }), ["checkout.read", "checkout.write"]);
  assert.match(empty, /role="alert"[^>]*>取得失敗/);
  assert.doesNotMatch(empty, /customer@example.test/);
  for (const button of empty.match(/<button\b[^>]*type="submit"[^>]*>/g) ?? []) assert.match(button, /\bdisabled/);
});

test("サーバーのプレビューは宛先と本文を安全に表示する", () => {
  const html = renderToStaticMarkup(createElement(ReceiptEmailPreviewContent, { preview: {
    subject: "領収書 <script>件名</script>", text: "領収書\nお客様<script>本文</script>\n合計 ¥5,500", pdf: { ...pdf, fileName: "領収書<script>ファイル名</script>.pdf" }, previewHash, fields: { version: 2, recipientEmail: "customer@example.test", recipientName: "お客様", description: "施術代" }
  } }));
  assert.match(html, /customer@example.test/); assert.match(html, /領収書\nお客様&lt;script&gt;本文&lt;\/script&gt;\n合計 ¥5,500/);
  assert.match(html, /&lt;script&gt;件名&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /領収書&lt;script&gt;ファイル名&lt;\/script&gt;\.pdf/);
  assert.doesNotMatch(html, /<iframe|data:application\/pdf|contentBase64/);
  assert.ok(!html.includes(pdf.contentBase64));
});

test("履歴は送信待ち・処理中・受付済み・失敗・中止を区別し、受付を受信確認として扱わない", () => {
  const statuses = ["PENDING", "PROCESSING", "SENT", "FAILED", "SKIPPED"] as const;
  const html = renderToStaticMarkup(createElement(ReceiptEmailHistory, { history: [...statuses.map((status) => ({ ...record, id: status, status, recipientName: "顧客<script>名前</script>" })), { ...record, id: "legacy", format: "TEXT" }] }));
  for (const label of ["送信待ち", "送信処理中", "メールサービス受付済み", "送信失敗", "送付中止", "お客様の受信は未確認です", "宛先を確認して新たに送付"]) assert.ok(html.includes(label), label);
  assert.match(html, /顧客&lt;script&gt;名前&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /PDF/); assert.match(html, /メール本文（旧形式）/);
});

test("プレビューはテナントと会計IDを分離し、会計バージョンと編集可能な三項目だけを送る", async (context) => {
  const calls: { url: string; init: RequestInit }[] = [];
  context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(url.endsWith("/preview") ? { subject: "領収書", text: "正規本文", pdf, previewHash } : data); });
  const abort = new AbortController();
  const preview = await prepareReceiptEmail("salon-test", "checkout/test", { version: 2, recipientEmail: " customer@example.test ", recipientName: " 顧客 ", description: " 施術代として " }, abort.signal);
  assert.equal(calls[0].url, "/api/salon-test/backend/cash/checkouts/checkout%2Ftest/receipt-emails/preview");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代として" });
  assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.cache, "no-store"); assert.equal(calls[0].init.signal, abort.signal);
  assert.equal(preview.text, "正規本文"); assert.equal(preview.subject, "領収書"); assert.ok(Object.isFrozen(preview.fields));
  assert.deepEqual(preview.pdf, pdf); assert.equal(preview.previewHash, previewHash);
  assert.deepEqual(await loadReceiptEmails("salon-test", "checkout-test", abort.signal), data);
  assert.equal(calls[1].init.method, "GET"); assert.equal(calls[1].init.body, undefined); assert.equal(calls[1].init.cache, "no-store");
});

test("通信結果が不明な送付の再試行は同じUUIDとプレビュー済み内容を保つ", async (context) => {
  const calls: string[] = [];
  const fields = { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代として" };
  const preview = { fields, subject: "領収書", text: "正規本文", pdf, previewHash };
  const attempt = createReceiptEmailAttempt(preview, "same-request-id");
  fields.recipientEmail = "changed@example.test";
  preview.previewHash = "b".repeat(64);
  context.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { calls.push(String(init.body)); if (calls.length === 1) throw new TypeError("通信切断"); return Response.json(record, { status: 202 }); });
  await assert.rejects(sendReceiptEmail("salon-test", "checkout-test", attempt), /通信切断/);
  assert.deepEqual(await sendReceiptEmail("salon-test", "checkout-test", attempt), record);
  assert.equal(calls[0], calls[1]);
  assert.deepEqual(JSON.parse(calls[1]), { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代として", requestId: "same-request-id", previewHash });
  assert.ok(Object.isFrozen(attempt)); assert.ok(Object.isFrozen(attempt.fields));
});

test("失効した会計などのAPIエラーを成功として扱わない", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ message: "会計が変更されています。最新の状態を確認してください。" }, { status: 409 }));
  await assert.rejects(prepareReceiptEmail("salon-test", "checkout-test", { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代" }), /会計が変更/);
  const attempt = createReceiptEmailAttempt({ subject: "領収書", text: "本文", pdf, previewHash, fields: { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代" } }, "rejected-request");
  await assert.rejects(sendReceiptEmail("salon-test", "checkout-test", attempt), (error: unknown) => error instanceof ReceiptEmailRequestError && error.status === 409);
});

test("送付の成功応答が壊れている場合は結果不明として扱い、同じ試行を再確認できる", async (context) => {
  const attempt = createReceiptEmailAttempt({ subject: "領収書", text: "本文", pdf, previewHash, fields: { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代" } }, "uncertain-request");
  for (const response of [new Response("not-json", { status: 202 }), Response.json(null, { status: 202 }), Response.json({ status: "PENDING" }, { status: 202 }), Response.json({ ...record, format: "HTML" }, { status: 202 })]) {
    context.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(sendReceiptEmail("salon-test", "checkout-test", attempt), (error: unknown) => error instanceof ReceiptEmailRequestError && error.status === undefined);
  }
  context.mock.method(globalThis, "fetch", async () => Response.json(record, { status: 202 }));
  assert.deepEqual(await sendReceiptEmail("salon-test", "checkout-test", attempt), record);
});

test("発行事業者未設定では送付を有効にせず、設定権限を持つ担当者だけに設定リンクを表示する", () => {
  for (const issuer of [{ name: null, registrationNumber: null, configured: false }, { name: "事業者", registrationNumber: null, configured: false }]) {
    const initialData = { ...data, issuer };
    const withoutSettings = render(createElement(ReceiptEmail, { checkout, initialData }), ["checkout.read", "checkout.write"]);
    const withSettings = render(createElement(ReceiptEmail, { checkout, initialData }), ["checkout.read", "checkout.write", "settings.write"]);
    for (const html of [withoutSettings, withSettings]) {
      for (const button of html.match(/<button\b[^>]*type="submit"[^>]*>/g) ?? []) assert.match(button, /\bdisabled/);
      assert.match(html, /発行事業者|発行者/);
    }
    assert.doesNotMatch(withoutSettings, /href="\/salon-test\/settings(?:["/?#])/);
    assert.match(withSettings, /href="\/salon-test\/settings(?:["/?#])/);
  }
});

test("SSRと再取得で共通の応答検証を使い、壊れた発行者と履歴形式を受け付けない", async (context) => {
  assert.deepEqual(parseReceiptEmailContext(data), data);
  const partialIssuer = { ...data, issuer: { name: "発行者", registrationNumber: null, configured: false } };
  assert.deepEqual(parseReceiptEmailContext(partialIssuer), partialIssuer);
  for (const invalid of [null, {}, { ...data, issuer: undefined }, { ...data, issuer: null },
    { ...data, issuer: { name: "発行者", registrationNumber: "T1234567890123", configured: "true" } },
    { ...data, issuer: { name: "", registrationNumber: "T1234567890123", configured: true } },
    { ...data, issuer: { name: "発行者", registrationNumber: null, configured: true } },
    { ...data, issuer: { name: "発行者", registrationNumber: "T123", configured: true } },
    { ...data, history: [{ ...record, format: undefined }] }, { ...data, history: [{ ...record, format: "HTML" }] }
  ]) assert.throws(() => parseReceiptEmailContext(invalid), ReceiptEmailRequestError);
  context.mock.method(globalThis, "fetch", async () => Response.json({ ...data, issuer: null }));
  await assert.rejects(loadReceiptEmails("salon-test", "checkout-test"), ReceiptEmailRequestError);
});

test("PDFや確認ハッシュが欠けたプレビューを送付確認に進めない", async (context) => {
  const valid = { subject: "領収書", text: "本文", pdf, previewHash };
  for (const response of [{ subject: "領収書", text: "本文" }, { ...valid, pdf: null }, { ...valid, pdf: { fileName: "領収書.pdf" } },
    { ...valid, previewHash: undefined }, { ...valid, previewHash: "a".repeat(63) }, { ...valid, previewHash: "g".repeat(64) }]) {
    context.mock.method(globalThis, "fetch", async () => Response.json(response));
    await assert.rejects(prepareReceiptEmail("salon-test", "checkout-test", { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代" }), ReceiptEmailRequestError);
  }
});

test("PDFリソースはPDF Blobを作成し、破棄は一度だけURLを解放する", async (context) => {
  const blobs: Blob[] = []; const revoked: string[] = [];
  context.mock.method(URL, "createObjectURL", (blob: unknown) => { assert.ok(blob instanceof Blob); blobs.push(blob); return "blob:receipt-preview-test"; });
  context.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); });
  const resource = createReceiptPdfResource(pdf);
  assert.equal(resource.url, "blob:receipt-preview-test"); assert.equal(blobs.length, 1);
  assert.equal(blobs[0].type, "application/pdf"); assert.deepEqual(Buffer.from(await blobs[0].arrayBuffer()), pdfBytes);
  resource.dispose(); resource.dispose(); assert.deepEqual(revoked, ["blob:receipt-preview-test"]);
});

test("PDFリソースは危険なファイル名・非正規Base64・PDFでない内容をBlob化しない", (context) => {
  const created = context.mock.method(URL, "createObjectURL", () => "blob:must-not-be-created");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const paddingIndex = pdf.contentBase64.indexOf("="); assert.ok(paddingIndex > 0);
  const index = paddingIndex - 1;
  const nonCanonical = `${pdf.contentBase64.slice(0, index)}${alphabet[alphabet.indexOf(pdf.contentBase64[index]) + 1]}${pdf.contentBase64.slice(paddingIndex)}`;
  const invalidPdfs = [
    ...["", "../receipt.pdf", "receipts/receipt.pdf", "receipts\\receipt.pdf", "receipt.html", "receipt.pdf\n", "receipt\u0000.pdf"].map((fileName) => ({ ...pdf, fileName })),
    ...["", `${pdf.contentBase64}\n`, `\u0000${pdf.contentBase64}`, `é${pdf.contentBase64}`, "%%%%", pdf.contentBase64.slice(0, -1), nonCanonical].map((contentBase64) => ({ ...pdf, contentBase64 })),
    { ...pdf, contentBase64: Buffer.from("not a PDF\n%%EOF\n").toString("base64") },
    { ...pdf, contentBase64: Buffer.from("%PDF-1.7\nmissing end marker\n").toString("base64") },
    { ...pdf, contentBase64: Buffer.from("%PDF-1.7\n%%EOF\n<script>extra</script>").toString("base64") }
  ];
  for (const invalid of invalidPdfs) assert.throws(() => createReceiptPdfResource(invalid), Error);
  assert.equal(created.mock.callCount(), 0);
});

test("PDFリソースは6 MiBまでを許可し、超過データをURL作成前に拒否する", (context) => {
  const maxBytes = 6 * 1024 * 1024;
  const created = context.mock.method(URL, "createObjectURL", () => "blob:receipt-boundary-test");
  const revoked = context.mock.method(URL, "revokeObjectURL", () => {});
  const bytes = Buffer.alloc(maxBytes, 0x20);
  bytes.write("%PDF-1.7\n", 0, "ascii"); bytes.write("%%EOF\n", maxBytes - 6, "ascii");
  const resource = createReceiptPdfResource({ ...pdf, contentBase64: bytes.toString("base64") });
  assert.equal(created.mock.callCount(), 1); resource.dispose(); assert.equal(revoked.mock.callCount(), 1);
  assert.throws(() => createReceiptPdfResource({ ...pdf, contentBase64: Buffer.concat([bytes, Buffer.from("\n")]).toString("base64") }), Error);
  assert.equal(created.mock.callCount(), 1);
});
