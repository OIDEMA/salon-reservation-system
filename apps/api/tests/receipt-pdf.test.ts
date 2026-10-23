import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import PDFDocument from "pdfkit";
import { buildReceiptPdf, receiptPdfFileName } from "../src/receipt-pdf.js";
import { RECEIPT_PDF_MAX_BYTES, type ReceiptSnapshot } from "../src/receipt-email.js";
import { CashError } from "../src/cash-domain.js";

function snapshot(count = 1, long = false): ReceiptSnapshot {
  const items = Array.from({ length: count }, (_, index) => ({ label: long ? `${String(index + 1).padStart(3, "0")}番の施術`.padEnd(160, "あ") : "フェイシャル施術", quantity: 1, unitPriceYen: 1100, discountYen: 50, pointsDiscountYen: 50, taxRate: 10 as const, taxYen: 90, totalYen: 1000 }));
  // Tax is calculated once per rate, then distributed across its line items.
  const tax = Math.floor(count * 1000 * 10 / 110);
  items[items.length - 1].taxYen += tax - items.reduce((sum, item) => sum + item.taxYen, 0);
  return { documentVersion: 1, issuerLegalName: long ? "正式事業者名".padEnd(300, "会") : "株式会社 テストサロン", invoiceRegistrationNumber: "T1234567890123",
    receiptNumber: "02c439b7-8b92-4f50-9697-b4a4d936c923", issuerName: long ? "店舗名".padEnd(300, "店") : "テストサロン 高松店", paidAt: "2026-10-23T01:23:45.000Z", treatmentAt: "2026-10-23T00:00:00.000Z", timezone: "Asia/Tokyo",
    recipientName: long ? "お客様".padEnd(100, "様") : "領収 太郎", description: long ? "施術代として".padEnd(200, "施") : "施術代として",
    subtotalYen: count * 1100, discountYen: count * 50, pointsDiscountYen: count * 50, taxYen: tax, totalYen: count * 1000, items,
    taxBreakdown: [{ taxRate: 10, taxableTotalYen: count * 1000, taxYen: tax }], payments: [{ method: "CASH", amountYen: count * 1000 }] };
}

test("receipt PDF is an A4 document with an embedded Japanese font, complete trailer and fixed metadata", async () => {
  const receipt = snapshot();
  const bytes = await buildReceiptPdf(receipt);
  const source = bytes.toString("latin1");
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.match(source, /\/MediaBox \[0 0 595\.28 841\.89\]/);
  assert.match(source, /NotoSansCJKjp-Regular/); assert.match(source, /\/FontFile3/);
  for (const key of ["CreationDate", "ModDate"]) {
    const reference = source.match(new RegExp(`/${key} (\\d+) 0 R`));
    assert.ok(reference, `${key} metadata exists`);
    assert.ok(source.includes(`${reference[1]} 0 obj\n(D:20261023012345Z)\nendobj`), `${key} uses captured payment time`);
  }
  assert.equal((source.match(/\/Type \/Page\b/g) ?? []).length, 1);
  assert.match(source, /startxref\s+\d+\s+%%EOF\s*$/);
  assert.ok(bytes.length > 1000 && bytes.length <= RECEIPT_PDF_MAX_BYTES);
  assert.equal(receiptPdfFileName(receipt), `receipt-${receipt.receiptNumber}.pdf`);
});

test("the exact same captured receipt produces identical PDF bytes and hashes", async () => {
  const receipt = snapshot(3);
  const first = await buildReceiptPdf(receipt);
  const second = await buildReceiptPdf(structuredClone(receipt));
  assert.deepEqual(first, second);
  assert.equal(createHash("sha256").update(first).digest("hex"), createHash("sha256").update(second).digest("hex"));
  const changed = await buildReceiptPdf({ ...receipt, recipientName: "別のお客様" });
  assert.notDeepEqual(first, changed);
});

test("100 longest items and maximum recipient, issuer, store and description text paginate within the attachment limit", async () => {
  const receipt = snapshot(100, true);
  const bytes = await buildReceiptPdf(receipt);
  const source = bytes.toString("latin1");
  const pageCount = (source.match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pageCount > 3 && pageCount < 35, `Expected multiple complete pages, got ${pageCount}`);
  assert.ok(bytes.length <= RECEIPT_PDF_MAX_BYTES);
  assert.match(source, /%%EOF\s*$/);
});

test("a long first item stays on the same page as the details title and column headings", async (context) => {
  const receipt = snapshot(100, true);
  const drawn: { value: string; page: PDFKit.PDFPage }[] = [];
  const original = PDFDocument.prototype.text;
  context.mock.method(PDFDocument.prototype, "text", function (this: PDFKit.PDFDocument, value: string, ...args: unknown[]) {
    drawn.push({ value, page: this.page });
    return Reflect.apply(original, this, [value, ...args]);
  });
  await buildReceiptPdf(receipt);
  const title = drawn.find((entry) => entry.value === "明細（税込）");
  const firstItem = drawn.find((entry) => entry.value === `1. ${receipt.items[0].label}`);
  assert.ok(title); assert.ok(firstItem);
  assert.equal(title.page, firstItem.page);
  const header = drawn.find((entry) => entry.value === "内容" && entry.page === title.page);
  assert.ok(header, "The column headings share the title and first item's page");
});

test("PDF generation requires document version 1 and refuses malformed or inconsistent snapshots", async () => {
  const receipt = snapshot();
  const old = { ...receipt, documentVersion: undefined };
  await assert.rejects(buildReceiptPdf(old), (error: unknown) => error instanceof CashError && error.code === "RECEIPT_PDF_VERSION_UNSUPPORTED");
  assert.throws(() => receiptPdfFileName(old), (error: unknown) => error instanceof CashError && error.code === "RECEIPT_PDF_VERSION_UNSUPPORTED");
  await assert.rejects(buildReceiptPdf({ ...receipt, issuerLegalName: undefined }));
  await assert.rejects(buildReceiptPdf({ ...receipt, totalYen: receipt.totalYen + 1 }));
  assert.throws(() => receiptPdfFileName({ ...receipt, receiptNumber: "../../invalid" }));
});
