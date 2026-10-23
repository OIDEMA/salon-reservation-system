import PDFDocument from "pdfkit";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CashError } from "./cash-domain.js";
import { receiptSnapshotSchema, RECEIPT_PDF_MAX_BYTES, type ReceiptSnapshot } from "./receipt-email.js";

const palette = { teal: "#117F7B", paleTeal: "#EDF8F6", ink: "#243746", muted: "#607482", line: "#D9E3E7", pale: "#F6F8FA", white: "#FFFFFF" };
const paymentLabels: Record<ReceiptSnapshot["payments"][number]["method"], string> = {
  CASH: "現金", CARD: "カード", BANK: "銀行振込", EXTERNAL_PREPAYMENT: "事前入金", OTHER: "その他"
};
let fontData: Buffer | undefined;
function receiptFont() {
  if (fontData) return fontData;
  // Source modules live under src/; compiled modules live under dist/src/.
  const candidates = ["../assets/fonts/NotoSansCJKjp-Regular.otf", "../../assets/fonts/NotoSansCJKjp-Regular.otf"]
    .map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new CashError("RECEIPT_PDF_UNAVAILABLE", "領収書PDFの作成に必要なフォントを確認できません。", 503);
  fontData = readFileSync(path);
  return fontData;
}

function validateReceipt(input: ReceiptSnapshot) {
  const receipt = receiptSnapshotSchema.parse(input);
  if (receipt.documentVersion !== 1) throw new CashError("RECEIPT_PDF_VERSION_UNSUPPORTED", "この領収書の形式ではPDFを作成できません。", 409);
  return receipt;
}

export function receiptPdfFileName(input: ReceiptSnapshot): string {
  return `receipt-${validateReceipt(input).receiptNumber}.pdf`;
}

const money = (amount: number) => `¥${amount.toLocaleString("ja-JP")}`;
function receiptDate(value: string, timezone: string, withTime = false) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}) }).format(new Date(value));
}

function renderReceipt(doc: PDFKit.PDFDocument, receipt: ReceiptSnapshot) {
  const left = 42, width = doc.page.width - left * 2, bottom = doc.page.height - 63;
  let y = 48;
  doc.registerFont("ReceiptJP", receiptFont()).font("ReceiptJP");

  function height(text: string, size: number, textWidth = width, lineGap = 2) {
    return doc.fontSize(size).heightOfString(text, { width: textWidth, lineGap });
  }
  function text(value: string, x: number, at: number, textWidth: number, size = 10, color = palette.ink, align: "left" | "right" | "center" = "left") {
    doc.fontSize(size).fillColor(color).text(value, x, at, { width: textWidth, align, lineGap: 2 });
  }
  function rule(at: number, color = palette.line, weight = .6) {
    doc.save().strokeColor(color).lineWidth(weight).moveTo(left, at).lineTo(left + width, at).stroke().restore();
  }
  function newPage() {
    doc.addPage();
    text("領収書", left, 40, 100, 12, palette.teal);
    text(`領収番号 ${receipt.receiptNumber}`, left + 140, 44, width - 140, 8, palette.muted, "right");
    rule(69, palette.teal, 1);
    y = 88;
  }
  function ensureSpace(required: number) {
    if (y + required > bottom) newPage();
  }
  function section(title: string, required = 65) {
    ensureSpace(required);
    text(title, left, y, width, 12, palette.teal);
    y += 23;
  }
  function summaryRow(label: string, value: string, strong = false) {
    const rowHeight = Math.max(height(label, strong ? 11 : 9.5, width - 150), 15) + 5;
    ensureSpace(rowHeight);
    text(label, left + 10, y, width - 170, strong ? 11 : 9.5, strong ? palette.teal : palette.muted);
    text(value, left + width - 150, y, 140, strong ? 13 : 10, strong ? palette.teal : palette.ink, "right");
    y += rowHeight;
  }

  rule(y, palette.teal, 2);
  y += 17;
  text("領収書", left, y, 180, 27, palette.teal);
  text("RECEIPT", left + 200, y + 4, width - 200, 8, palette.muted, "right");
  text(`領収番号 ${receipt.receiptNumber}`, left + 180, y + 22, width - 180, 8, palette.muted, "right");
  y += 57;
  text(`領収日  ${receiptDate(receipt.paidAt, receipt.timezone)}`, left, y, width / 2, 9, palette.muted);
  text(`取引日  ${receiptDate(receipt.treatmentAt, receipt.timezone, true)}`, left + width / 2, y, width / 2, 9, palette.muted, "right");
  y += 28;
  const recipient = `${receipt.recipientName} 様`;
  const recipientHeight = height(recipient, 15);
  text(recipient, left, y, width, 15);
  y += recipientHeight + 9;
  rule(y);
  y += 16;
  doc.save().roundedRect(left, y, width, 76, 8).fill(palette.paleTeal).restore();
  text("領収金額（税込）", left + 18, y + 11, width - 36, 9, palette.teal);
  text(money(receipt.totalYen), left + 18, y + 29, width - 36, 27, palette.teal);
  y += 92;
  text("但し書き", left, y, 70, 9, palette.muted);
  const descriptionHeight = height(receipt.description, 10.5, width - 76);
  text(receipt.description, left + 76, y - 1, width - 76, 10.5);
  y += Math.max(descriptionHeight, 18) + 6;
  text("上記の金額を領収しました。", left, y, width, 9, palette.muted);
  y += 26;

  const issuerWidth = width - 105;
  const issuerHeight = height(receipt.issuerLegalName!, 10, issuerWidth);
  const storeHeight = height(receipt.issuerName, 9, issuerWidth);
  const issuerBlockHeight = issuerHeight + storeHeight + 44;
  ensureSpace(issuerBlockHeight + 20);
  doc.save().roundedRect(left, y, width, issuerBlockHeight, 6).fill(palette.pale).restore();
  text("発行事業者", left + 12, y + 12, 72, 8.5, palette.muted);
  text(receipt.issuerLegalName!, left + 91, y + 10, issuerWidth, 10);
  text("登録番号", left + 12, y + issuerHeight + 19, 72, 8.5, palette.muted);
  text(receipt.invoiceRegistrationNumber!, left + 91, y + issuerHeight + 17, issuerWidth, 10);
  text("店舗名", left + 12, y + issuerHeight + 37, 72, 8.5, palette.muted);
  text(receipt.issuerName, left + 91, y + issuerHeight + 35, issuerWidth, 9);
  y += issuerBlockHeight + 18;

  const columns = [
    { title: "内容", width: 174, align: "left" as const },
    { title: "数量", width: 29, align: "right" as const },
    { title: "単価（税込）", width: 65, align: "right" as const },
    { title: "通常値引", width: 58, align: "right" as const },
    { title: "ポイント", width: 58, align: "right" as const },
    { title: "金額（税込）", width: 77, align: "right" as const },
    { title: "税率", width: width - 461, align: "right" as const }
  ];
  function tableHeader() {
    doc.save().rect(left, y, width, 25).fill(palette.teal).restore();
    let x = left;
    for (const column of columns) { text(column.title, x + 5, y + 6, column.width - 10, 7.5, palette.white, column.align); x += column.width; }
    y += 25;
  }
  function itemValues(item: ReceiptSnapshot["items"][number], index: number) {
    return [`${index + 1}. ${item.label}`, String(item.quantity), money(item.unitPriceYen), money(item.discountYen), money(item.pointsDiscountYen ?? 0), money(item.totalYen), `${item.taxRate}%${item.taxRate === 8 ? " ※" : ""}`];
  }
  function itemRowHeight(values: string[]) {
    return Math.max(16, ...values.map((value, column) => height(value, column === 0 ? 9 : 8.2, columns[column].width - 10))) + 12;
  }
  // Keep the section title, column headings and the complete first item together.
  section("明細（税込）", 23 + 25 + itemRowHeight(itemValues(receipt.items[0], 0)));
  tableHeader();
  receipt.items.forEach((item, index) => {
    const values = itemValues(item, index);
    const rowHeight = itemRowHeight(values);
    if (y + rowHeight > bottom) { newPage(); tableHeader(); }
    if (index % 2 === 0) doc.save().rect(left, y, width, rowHeight).fill(palette.pale).restore();
    let x = left;
    values.forEach((value, column) => { text(value, x + 5, y + 6, columns[column].width - 10, column === 0 ? 9 : 8.2, palette.ink, columns[column].align); x += columns[column].width; });
    y += rowHeight;
    rule(y, palette.line, .4);
  });
  y += 10;
  if (receipt.items.some((item) => item.taxRate === 8)) {
    ensureSpace(25);
    text("※ 8%は軽減税率の対象です。", left, y, width, 8, palette.muted);
    y += 26;
  }

  ensureSpace(130);
  summaryRow("小計（税込）", money(receipt.subtotalYen));
  summaryRow("通常値引き", money(receipt.discountYen));
  summaryRow("ポイント利用値引き", money(receipt.pointsDiscountYen ?? 0));
  rule(y + 1);
  y += 8;
  summaryRow("合計（税込）", money(receipt.totalYen), true);
  summaryRow("うち消費税", money(receipt.taxYen));
  y += 14;

  section("税率別内訳", 46 + receipt.taxBreakdown.length * 23);
  for (const group of receipt.taxBreakdown) {
    ensureSpace(23);
    text(`${group.taxRate}%対象（税込）`, left + 10, y, 180, 9.5, palette.muted);
    text(money(group.taxableTotalYen), left + 170, y, 145, 10, palette.ink, "right");
    text(`うち消費税 ${money(group.taxYen)}`, left + 325, y, width - 335, 9, palette.ink, "right");
    y += 23;
  }
  y += 12;
  section("お支払い内訳", 60);
  for (const payment of receipt.payments) summaryRow(paymentLabels[payment.method], money(payment.amountYen));
  y += 8;
  const note = "このPDFを領収書として保管してください。";
  ensureSpace(height(note, 8.5));
  text(note, left, y, width, 8.5, palette.muted);

  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index++) {
    doc.switchToPage(index);
    const previousBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    rule(doc.page.height - 44);
    text("電子発行の領収書", left, doc.page.height - 33, width - 100, 8, palette.muted);
    text(`${index + 1} / ${pages.count}`, left + width - 100, doc.page.height - 33, 100, 8, palette.muted, "right");
    doc.page.margins.bottom = previousBottom;
  }
}

export async function buildReceiptPdf(input: ReceiptSnapshot): Promise<Buffer> {
  const receipt = validateReceipt(input);
  const fixedDate = new Date(receipt.paidAt);
  const doc = new PDFDocument({ size: "A4", margins: { top: 42, right: 42, bottom: 63, left: 42 }, bufferPages: true, compress: true,
    info: { Title: "領収書", Author: receipt.issuerLegalName, Subject: `領収書 ${receipt.receiptNumber}`, Creator: "SalonOps", Producer: "SalonOps", CreationDate: fixedDate, ModDate: fixedDate } });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0, failed = false;
    doc.on("data", (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > RECEIPT_PDF_MAX_BYTES) {
        failed = true;
        reject(new CashError("RECEIPT_PDF_TOO_LARGE", "領収書PDFが添付サイズの上限を超えています。明細を確認してください。", 409));
        doc.destroy();
      } else chunks.push(chunk);
    });
    doc.on("error", (error) => { failed = true; reject(error); });
    doc.on("end", () => { if (!failed) resolve(Buffer.concat(chunks, total)); });
    try { renderReceipt(doc, receipt); doc.end(); }
    catch (error) { failed = true; reject(error); doc.destroy(); }
  });
}
