"use client";

import { useEffect, useRef, useState } from "react";
import type { ReservationHistoryImportFile, ReservationHistoryImportProgress } from "@/lib/admin-types";
import { importReservationHistory, validateHistoryImportPreview } from "@/lib/reservation-history";
import { TenantLink } from "./tenant-link";
import { usePermissions, useTenantSlug } from "./tenant-provider";

export function ReservationHistoryImport() {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const [document, setDocument] = useState<ReservationHistoryImportFile | null>(null);
  const [progress, setProgress] = useState<ReservationHistoryImportProgress | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const readSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { ++readSequence.current; controller.current?.abort(); }, []);

  if (!can("reservation.write") || !can("chart.write")) return <p className="formMessage error" role="alert">予約履歴を取り込むには、予約と電子カルテの編集権限が必要です。</p>;
  if (tenantSlug !== "missmrs-takamatsu") return <p className="formMessage error" role="alert">このデータの登録先はミスミセス高松店です。</p>;

  async function chooseFile(file?: File) {
    const sequence = ++readSequence.current;
    setDocument(null); setProgress(null); setMessage("");
    if (!file) return;
    setReading(true);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("ファイルは20MB以下で選択してください。");
      const data = validateHistoryImportPreview(JSON.parse(await file.text()));
      if (sequence === readSequence.current) setDocument(data);
    } catch (error) {
      if (sequence === readSequence.current) setMessage(error instanceof SyntaxError ? "JSON形式の取込ファイルを選択してください。" : error instanceof Error ? error.message : "ファイルを読み込めませんでした。");
    } finally { if (sequence === readSequence.current) setReading(false); }
  }

  async function startImport() {
    if (!document || busy || reading || progress?.completed) return;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setMessage("");
    try {
      await importReservationHistory(tenantSlug, document, { signal: current.signal, onProgress: setProgress });
      if (!current.signal.aborted) setMessage("予約履歴の取り込みが完了しました。");
    } catch (error) {
      if (!current.signal.aborted) setMessage(`${error instanceof Error ? error.message : "取り込みに失敗しました。"} 同じファイルで登録を再開できます。`);
    } finally { if (!current.signal.aborted) setBusy(false); }
  }

  return <div className="customerImportForm">
    <label className="field"><span>予約履歴データ</span><input type="file" accept=".json,application/json" disabled={busy || reading} onChange={(event) => void chooseFile(event.target.files?.[0])} /></label>
    {document ? <p>{document.expectedCount.toLocaleString("ja-JP")}件 / 対象期間：{document.periodFrom}〜{document.periodTo}の前日 / 登録先：ミスミセス高松店</p> : null}
    <p>日時・担当・メニュー・金額・状態を保存します。同じ予約番号の履歴は重複登録しません。</p>
    {progress ? <div aria-live="polite">
      <p>{progress.processedCount.toLocaleString("ja-JP")} / {progress.expectedCount.toLocaleString("ja-JP")}件 完了</p>
      <progress max={progress.expectedCount} value={progress.processedCount} />
      <p>新規登録 {progress.createdCount.toLocaleString("ja-JP")}件 / 登録済み {progress.skippedCount.toLocaleString("ja-JP")}件</p>
      {progress.completed ? <div className="historyImportCounts">
        <section><h3>月別の件数</h3><dl>{Object.entries(progress.monthCounts).sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => <div key={month}><dt>{month}</dt><dd>{count.toLocaleString("ja-JP")}件</dd></div>)}</dl></section>
        <section><h3>状態別の件数</h3><dl>{Object.entries(progress.statusCounts).map(([status, count]) => <div key={status}><dt>{status}</dt><dd>{count.toLocaleString("ja-JP")}件</dd></div>)}</dl></section>
      </div> : null}
    </div> : null}
    {message ? <p className={`formMessage${progress?.completed ? "" : " error"}`} role={progress?.completed ? "status" : "alert"}>{message}</p> : null}
    <div className="adminActions"><button className="primaryButton" type="button" disabled={!document || reading || busy || progress?.completed} onClick={() => void startImport()}>{reading ? "ファイルを確認中..." : busy ? "登録中..." : progress && !progress.completed ? "登録を再開" : "登録を開始"}</button><TenantLink className="secondaryButton" href="/reservations/history">予約履歴一覧へ</TenantLink></div>
  </div>;
}
