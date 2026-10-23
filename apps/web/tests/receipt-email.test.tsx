import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptEmail, ReceiptEmailHistory, ReceiptEmailPreviewContent } from "../src/components/receipt-email";
import { TenantProvider } from "../src/components/tenant-provider";
import type { CashCheckout } from "../src/components/cash-types";
import { createReceiptEmailAttempt, loadReceiptEmails, prepareReceiptEmail, ReceiptEmailRequestError, sendReceiptEmail, type ReceiptEmailContext, type ReceiptEmailRecord } from "../src/lib/receipt-email";

const checkout: CashCheckout = {
  id: "checkout-test", reservationId: "reservation-test", status: "FINALIZED", version: 2,
  reservationSnapshot: { customerName: "領収書のお客様", serviceName: "施術", staffName: "担当", salonName: "店舗", startsAt: "2026-10-23T01:00:00Z" },
  items: [{ label: "施術", quantity: 1, unitPriceYen: 5500, discountYen: 0, taxRate: 10 }], payments: [{ method: "CASH", amountYen: 5500, reference: "" }],
  legacyPaymentStatus: "UNPAID", legacyPaidAcknowledged: false, subtotalYen: 5500, discountYen: 0, taxYen: 500, totalYen: 5500, cashYen: 5500, notes: "",
  taxBreakdown: [{ taxRate: 10, taxableTotalYen: 5500, taxYen: 500 }], finalizedAt: "2026-10-23T01:00:00Z", reversedAt: null, reversalReason: null
};
const record: ReceiptEmailRecord = { id: "mail-test", recipientEmail: "customer@example.test", recipientName: "領収書のお客様", description: "施術代として", status: "PENDING", createdAt: "2026-10-23T01:00:00Z", sentAt: null, lastErrorCode: null };
const data: ReceiptEmailContext = { defaultRecipientEmail: record.recipientEmail, defaultRecipientName: record.recipientName, defaultDescription: record.description, history: [record] };
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
  assert.match(empty, /value="領収書のお客様"/);
  assert.doesNotMatch(empty, /customer@example.test/);
});

test("サーバーのプレビューは宛先と本文を安全に表示する", () => {
  const html = renderToStaticMarkup(createElement(ReceiptEmailPreviewContent, { preview: {
    subject: "領収書 <script>件名</script>", text: "領収書\nお客様<script>本文</script>\n合計 ¥5,500", fields: { version: 2, recipientEmail: "customer@example.test", recipientName: "お客様", description: "施術代" }
  } }));
  assert.match(html, /customer@example.test/); assert.match(html, /領収書\nお客様&lt;script&gt;本文&lt;\/script&gt;\n合計 ¥5,500/);
  assert.match(html, /&lt;script&gt;件名&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test("履歴は送信待ち・処理中・受付済み・失敗・中止を区別し、受付を受信確認として扱わない", () => {
  const statuses = ["PENDING", "PROCESSING", "SENT", "FAILED", "SKIPPED"] as const;
  const html = renderToStaticMarkup(createElement(ReceiptEmailHistory, { history: statuses.map((status) => ({ ...record, id: status, status, recipientName: "顧客<script>名前</script>" })) }));
  for (const label of ["送信待ち", "送信処理中", "メールサービス受付済み", "送信失敗", "送付中止", "お客様の受信は未確認です", "宛先を確認して新たに送付"]) assert.ok(html.includes(label), label);
  assert.match(html, /顧客&lt;script&gt;名前&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test("プレビューはテナントと会計IDを分離し、会計バージョンと編集可能な三項目だけを送る", async (context) => {
  const calls: { url: string; init: RequestInit }[] = [];
  context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(url.endsWith("/preview") ? { subject: "領収書", text: "正規本文" } : data); });
  const abort = new AbortController();
  const preview = await prepareReceiptEmail("salon-test", "checkout/test", { version: 2, recipientEmail: " customer@example.test ", recipientName: " 顧客 ", description: " 施術代として " }, abort.signal);
  assert.equal(calls[0].url, "/api/salon-test/backend/cash/checkouts/checkout%2Ftest/receipt-emails/preview");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代として" });
  assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.cache, "no-store"); assert.equal(calls[0].init.signal, abort.signal);
  assert.equal(preview.text, "正規本文"); assert.equal(preview.subject, "領収書"); assert.ok(Object.isFrozen(preview.fields));
  assert.deepEqual(await loadReceiptEmails("salon-test", "checkout-test", abort.signal), data);
  assert.equal(calls[1].init.method, "GET"); assert.equal(calls[1].init.body, undefined); assert.equal(calls[1].init.cache, "no-store");
});

test("通信結果が不明な送付の再試行は同じUUIDとプレビュー済み内容を保つ", async (context) => {
  const calls: string[] = [];
  const fields = { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代として" };
  const attempt = createReceiptEmailAttempt({ fields, subject: "領収書", text: "正規本文" }, "same-request-id");
  fields.recipientEmail = "changed@example.test";
  context.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { calls.push(String(init.body)); if (calls.length === 1) throw new TypeError("通信切断"); return Response.json(record, { status: 202 }); });
  await assert.rejects(sendReceiptEmail("salon-test", "checkout-test", attempt), /通信切断/);
  assert.deepEqual(await sendReceiptEmail("salon-test", "checkout-test", attempt), record);
  assert.equal(calls[0], calls[1]);
  assert.deepEqual(JSON.parse(calls[1]), { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代として", requestId: "same-request-id" });
  assert.ok(Object.isFrozen(attempt)); assert.ok(Object.isFrozen(attempt.fields));
});

test("失効した会計などのAPIエラーを成功として扱わない", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ message: "会計が変更されています。最新の状態を確認してください。" }, { status: 409 }));
  await assert.rejects(prepareReceiptEmail("salon-test", "checkout-test", { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代" }), /会計が変更/);
  const attempt = createReceiptEmailAttempt({ subject: "領収書", text: "本文", fields: { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代" } }, "rejected-request");
  await assert.rejects(sendReceiptEmail("salon-test", "checkout-test", attempt), (error: unknown) => error instanceof ReceiptEmailRequestError && error.status === 409);
});

test("送付の成功応答が壊れている場合は結果不明として扱い、同じ試行を再確認できる", async (context) => {
  const attempt = createReceiptEmailAttempt({ subject: "領収書", text: "本文", fields: { version: 2, recipientEmail: "customer@example.test", recipientName: "顧客", description: "施術代" } }, "uncertain-request");
  for (const response of [new Response("not-json", { status: 202 }), Response.json(null, { status: 202 }), Response.json({ status: "PENDING" }, { status: 202 })]) {
    context.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(sendReceiptEmail("salon-test", "checkout-test", attempt), (error: unknown) => error instanceof ReceiptEmailRequestError && error.status === undefined);
  }
  context.mock.method(globalThis, "fetch", async () => Response.json(record, { status: 202 }));
  assert.deepEqual(await sendReceiptEmail("salon-test", "checkout-test", attempt), record);
});
