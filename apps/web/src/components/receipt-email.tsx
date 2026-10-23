"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { usePermissions, useTenantSlug } from "./tenant-provider";
import { TenantLink } from "./tenant-link";
import { createReceiptEmailAttempt, createReceiptPdfResource, loadReceiptEmails, prepareReceiptEmail, ReceiptEmailRequestError, receiptEmailStatusLabels, sendReceiptEmail,
  type ReceiptEmailAttempt, type ReceiptEmailContext, type ReceiptEmailFields, type ReceiptEmailPreview, type ReceiptEmailRecord } from "@/lib/receipt-email";
import type { CashCheckout } from "./cash-types";

function receiptDate(value: string) {
  return new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

export function ReceiptEmailHistory({ history }: { history: ReceiptEmailRecord[] }) {
  return history.length ? <ol className="receiptEmailHistory">{history.map((record) => <li key={record.id}>
    <div className="cashHeading"><strong>{receiptEmailStatusLabels[record.status]}</strong><time dateTime={record.createdAt}>{receiptDate(record.createdAt)}</time></div>
    <p>{record.recipientName} 様 / <span className="receiptEmailAddress">{record.recipientEmail}</span><br />但し書き：{record.description}<br />形式：{record.format === "PDF" ? "PDF添付" : "メール本文（旧形式）"}</p>
    {record.status === "SENT" ? <p className="cashReceiptFootnote">メールサービスが受け付けました。お客様の受信は未確認です。{record.sentAt ? `（${receiptDate(record.sentAt)}）` : ""}</p> : null}
    {record.status === "FAILED" ? <p className="cashDifference">送信できませんでした。宛先を確認して新たに送付してください。</p> : null}
    {record.status === "SKIPPED" ? <p className="cashReceiptFootnote">会計の取消などにより送付を中止しました。</p> : null}
  </li>)}</ol> : <p>領収書メールの送付履歴はありません。</p>;
}

export function ReceiptEmailPreviewContent({ preview, onPdfReady }: { preview: ReceiptEmailPreview; onPdfReady?: (ready: boolean) => void }) {
  const [resource, setResource] = useState<{ pdf: ReceiptEmailPreview["pdf"]; url: string } | null>(null);
  const [pdfError, setPdfError] = useState("");
  useEffect(() => {
    onPdfReady?.(false); setPdfError("");
    let pdf: ReturnType<typeof createReceiptPdfResource> | undefined;
    try {
      pdf = createReceiptPdfResource(preview.pdf);
      setResource({ pdf: preview.pdf, url: pdf.url }); onPdfReady?.(true);
    } catch { setResource(null); setPdfError("PDFを表示できませんでした。内容を修正して、プレビューを取得し直してください。"); }
    return () => { pdf?.dispose(); onPdfReady?.(false); };
  }, [preview.pdf, onPdfReady]);
  const pdfUrl = resource?.pdf === preview.pdf ? resource.url : null;
  return <div className="receiptEmailPreview"><dl className="receiptEmailSummary"><div><dt>送付先</dt><dd>{preview.fields.recipientEmail}</dd></div><div><dt>件名</dt><dd>{preview.subject}</dd></div><div><dt>添付PDF</dt><dd>{preview.pdf.fileName}</dd></div></dl>
    <div className="receiptPdfPreview">{pdfUrl ? <>
      <div className="receiptPdfActions"><a className="secondaryButton" href={pdfUrl} target="_blank" rel="noopener noreferrer">PDFを別画面で開く</a><a className="secondaryButton" href={pdfUrl} download={preview.pdf.fileName}>PDFをダウンロード</a></div>
      <iframe title="送付するPDF領収書" src={pdfUrl} referrerPolicy="no-referrer" />
      <p className="cashReceiptFootnote">PDFが表示されない場合は、別画面で開くかダウンロードして内容を確認してください。</p>
    </> : pdfError ? <p role="alert" className="formMessage error">{pdfError}</p> : <p role="status">PDFプレビューを準備しています。</p>}</div>
    <details className="receiptEmailBody"><summary>メール本文を確認</summary><pre>{preview.text}</pre></details>
  </div>;
}

export function ReceiptEmail({ checkout, initialData, initialError = "" }: { checkout: CashCheckout; initialData: ReceiptEmailContext | null; initialError?: string }) {
  const slug = useTenantSlug();
  const { can } = usePermissions();
  const [data, setData] = useState(initialData);
  const [fields, setFields] = useState<ReceiptEmailFields>({ version: checkout.version, recipientEmail: initialData?.defaultRecipientEmail ?? "", recipientName: initialData?.defaultRecipientName ?? checkout.reservationSnapshot.customerName, description: initialData?.defaultDescription ?? "施術代として" });
  const [preview, setPreview] = useState<ReceiptEmailPreview | null>(null);
  const [pdfReady, setPdfReady] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState(initialError);
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<ReceiptEmailRecord | null>(null);
  const attempt = useRef<ReceiptEmailAttempt | null>(null);
  const canPrepare = checkout.status === "FINALIZED" && can("checkout.write");
  const issuerConfigured = Boolean(data?.issuer?.configured && data.issuer.name?.trim() && /^T\d{13}$/.test(data.issuer.registrationNumber ?? ""));
  const canSend = canPrepare && issuerConfigured;

  async function refreshHistory() {
    if (historyBusy) return;
    setHistoryBusy(true); setHistoryError("");
    try {
      const latest = await loadReceiptEmails(slug, checkout.id);
      setData(latest);
      setResult((current) => current ? latest.history.find((record) => record.id === current.id) ?? current : null);
    }
    catch (failure) { setHistoryError(failure instanceof Error ? failure.message : "送付履歴を取得できませんでした。"); }
    finally { setHistoryBusy(false); }
  }

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canSend || preview) return;
    setBusy(true); setError("");
    try {
      const prepared = await prepareReceiptEmail(slug, checkout.id, fields);
      setPdfReady(false); setPreview(prepared); setConfirmed(false); setAttempted(false); attempt.current = null;
    } catch (failure) { setError(failure instanceof Error ? failure.message : "プレビューを取得できませんでした。"); }
    finally { setBusy(false); }
  }

  async function send() {
    if (busy || !canSend || !preview || !pdfReady || !confirmed) return;
    setBusy(true); setError(""); setAttempted(true);
    attempt.current ??= createReceiptEmailAttempt(preview, crypto.randomUUID());
    try {
      const sent = await sendReceiptEmail(slug, checkout.id, attempt.current);
      setResult(sent);
      setData((current) => current ? ({ ...current, defaultRecipientEmail: sent.recipientEmail, defaultRecipientName: sent.recipientName, defaultDescription: sent.description, history: [sent, ...current.history.filter((record) => record.id !== sent.id)].slice(0, 50) }) : current);
    } catch (failure) {
      const rejected = failure instanceof ReceiptEmailRequestError && failure.status !== undefined && failure.status >= 400 && failure.status < 500;
      if (rejected) { setAttempted(false); setConfirmed(false); attempt.current = null; }
      setError(`${failure instanceof Error ? failure.message : "送付結果を確認できませんでした。"}${rejected ? " 内容を確認して、必要に応じて修正してください。" : " 同じ内容で再試行すると、重複する送付を防いで結果を確認できます。"}`);
    } finally { setBusy(false); }
  }

  function reset() {
    setPreview(null); setPdfReady(false); setConfirmed(false); setAttempted(false); setResult(null); setError(""); attempt.current = null;
  }

  if (!can("checkout.read")) return null;
  return <section className="adminPanel cashPanel cashNoPrint receiptEmailPanel" aria-label="領収書メール">
    <h2>PDF領収書をメールで送付</h2>
    {data?.issuer ? <dl className="receiptIssuerSummary"><div><dt>発行事業者</dt><dd>{data.issuer.name || "未設定"}</dd></div><div><dt>登録番号</dt><dd>{data.issuer.registrationNumber || "未設定"}</dd></div></dl> : null}
    {canSend ? <>
      <p>確定した施術明細と支払金額を記載したPDF領収書を、メールに添付して送付します。送付前にPDFと宛先を確認してください。</p>
      {!preview ? <form className="cashStack" onSubmit={(event) => void prepare(event)}>
        <label className="createField"><span>送付先メールアドレス</span><input required type="email" autoComplete="off" maxLength={254} disabled={busy} value={fields.recipientEmail} onChange={(event) => setFields((current) => ({ ...current, recipientEmail: event.target.value }))} /></label>
        <div className="cashTwoPanels"><label className="createField"><span>領収書の宛名</span><input required maxLength={100} disabled={busy} value={fields.recipientName} onChange={(event) => setFields((current) => ({ ...current, recipientName: event.target.value }))} /><small>末尾に「様」を付けて表示します。</small></label>
          <label className="createField"><span>但し書き</span><input required maxLength={200} disabled={busy} value={fields.description} onChange={(event) => setFields((current) => ({ ...current, description: event.target.value }))} /></label></div>
        <div><button className="primaryButton" disabled={busy} type="submit">{busy ? "内容を取得中..." : "送付内容を確認"}</button></div>
      </form> : <div className="cashStack">
        <h3>送付するPDF領収書のプレビュー</h3><ReceiptEmailPreviewContent preview={preview} onPdfReady={setPdfReady} />
        {result ? <div role="status" className="cashNotice"><p>領収書メールの状態：<strong>{receiptEmailStatusLabels[result.status]}</strong></p><p>送付履歴を更新すると最新の状態を確認できます。</p><button className="secondaryButton" type="button" onClick={reset}>新たな送付を準備</button></div> : <>
          <label className="cashCheck"><input type="checkbox" disabled={busy || !pdfReady} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>PDFの宛名・金額・明細・発行事業者名・登録番号と、送付先メールアドレスを確認しました</span></label>
          <div className="cashFooter">{!attempted ? <button className="secondaryButton" type="button" disabled={busy} onClick={reset}>内容を修正</button> : <p className="cashReceiptFootnote">送付結果を確認するまで、この内容で再試行してください。</p>}
            <button className="primaryButton" type="button" disabled={busy || !confirmed || !pdfReady} onClick={() => void send()}>{busy ? "送付を登録中..." : attempted ? "同じ内容で再試行" : "このPDF領収書を添付して送付"}</button></div>
        </>}
      </div>}
      {error ? <p role="alert" className="formMessage error">{error}</p> : null}
    </> : !issuerConfigured && checkout.status === "FINALIZED" ? <div className="cashNotice"><p>{data ? "PDF領収書を送付するには、領収書の発行事業者名と適格請求書発行事業者の登録番号を設定してください。" : "発行事業者情報を取得できていません。送付履歴を更新して確認してください。"}</p>{can("settings.write") ? <TenantLink href="/settings" className="secondaryButton">領収書の発行者設定へ</TenantLink> : <p>設定について店舗の管理者にお問い合わせください。</p>}</div> : <p className="cashNotice">{checkout.status === "REVERSED" ? "全額取消済みの会計は領収書を送付できません。" : checkout.status === "DRAFT" ? "会計を確定してから領収書を送付してください。" : "領収書の送付には会計の確定権限が必要です。"}</p>}
    <div className="receiptEmailHistorySection"><div className="cashHeading"><h3>送付履歴</h3><button className="secondaryButton" type="button" disabled={historyBusy} onClick={() => void refreshHistory()}>{historyBusy ? "取得中..." : "送付履歴を更新"}</button></div>
      {historyError ? <p role="alert" className="formMessage error">{historyError}</p> : null}
      <div aria-busy={historyBusy}>{data ? <ReceiptEmailHistory history={data.history} /> : <p>送付履歴を取得できていません。「送付履歴を更新」で再取得してください。</p>}</div>
    </div>
  </section>;
}
