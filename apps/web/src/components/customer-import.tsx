"use client";

import { useEffect, useRef, useState } from "react";
import { TenantLink } from "./tenant-link";
import { usePermissions, useTenantSlug } from "./tenant-provider";
import { tenantApiPath } from "@/lib/tenant-routing";

type ImportFile = {
  version: 1; source: "SALONBOARD"; sourceStoreId: string;
  expectedCount: number; capturedAt: string; records: unknown[];
};
type ImportProgress = {
  id: string; expectedCount: number; chunkSize: number; processedCount: number;
  createdCount: number; skippedCount: number; remainingCount: number;
  completed: boolean; processedOffsets: number[];
};

async function importResponse(response: Response): Promise<ImportProgress> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message ?? `取り込みに失敗しました（${response.status}）。`);
  return body as ImportProgress;
}

export function CustomerImport() {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const [document, setDocument] = useState<ImportFile | null>(null);
  const [filename, setFilename] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const readSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  useEffect(() => () => { ++readSequence.current; requestController.current?.abort(); }, []);

  if (!can("customer.write") || !can("chart.write")) {
    return <p className="formMessage error" role="alert">顧客データを取り込む権限がありません。</p>;
  }
  if (tenantSlug !== "missmrs-takamatsu") {
    return <p className="formMessage error" role="alert">この移行データの登録先はミスミセス高松店です。</p>;
  }

  async function chooseFile(file?: File) {
    const sequence = ++readSequence.current;
    setDocument(null); setProgress(null); setMessage(""); setFilename(file?.name ?? "");
    if (!file) return;
    setReading(true);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("ファイルは10MB以下で選択してください。");
      const data = JSON.parse(await file.text()) as ImportFile;
      if (data.version !== 1 || data.source !== "SALONBOARD" || data.sourceStoreId !== "H000551123" ||
        !Array.isArray(data.records) || !Number.isInteger(data.expectedCount) ||
        data.expectedCount < 1 || data.expectedCount > 10000 || data.records.length !== data.expectedCount) {
        throw new Error("ミスミセス高松店の移行ファイルと件数を確認してください。");
      }
      if (sequence === readSequence.current) setDocument(data);
    } catch (error) {
      if (sequence === readSequence.current) setMessage(error instanceof SyntaxError ? "JSON形式の移行ファイルを選択してください。" : error instanceof Error ? error.message : "ファイルを読み込めませんでした。");
    } finally { if (sequence === readSequence.current) setReading(false); }
  }

  async function importCustomers() {
    if (!document || busy || reading) return;
    const controller = new AbortController();
    requestController.current = controller;
    setBusy(true); setMessage("");
    const path = tenantApiPath(tenantSlug, "/admin/customer-imports/salonboard");
    const options = { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store" as const, signal: controller.signal };
    try {
      let result = await importResponse(await fetch(`${path}/prepare`, { ...options, body: JSON.stringify(document) }));
      if (controller.signal.aborted) return;
      setProgress(result);
      for (let offset = 0; offset < document.records.length; offset += result.chunkSize) {
        if (result.processedOffsets.includes(offset)) continue;
        result = await importResponse(await fetch(`${path}/${encodeURIComponent(result.id)}/chunks`, {
          ...options, body: JSON.stringify({ offset, records: document.records.slice(offset, offset + result.chunkSize) })
        }));
        if (controller.signal.aborted) return;
        setProgress(result);
      }
      if (!result.completed) throw new Error("一部の登録が未完了です。登録を再開してください。");
      setMessage("顧客データの取り込みが完了しました。");
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "取り込みに失敗しました。登録を再開してください。");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <div className="customerImportForm">
    <label className="field"><span>サロンボードの顧客データ</span>
      <input type="file" accept=".json,application/json" disabled={busy || reading} onChange={(event) => void chooseFile(event.target.files?.[0])} />
    </label>
    {document ? <p>{filename} / {document.expectedCount.toLocaleString("ja-JP")}件 / 登録先：ミスミセス高松店</p> : null}
    {progress ? <div aria-live="polite"><p>{progress.processedCount.toLocaleString("ja-JP")} / {progress.expectedCount.toLocaleString("ja-JP")}件 完了</p>
      <progress max={progress.expectedCount} value={progress.processedCount} />
      <p>新規登録 {progress.createdCount.toLocaleString("ja-JP")}件 / 登録済み {progress.skippedCount.toLocaleString("ja-JP")}件</p>
    </div> : null}
    {message ? <p className="formMessage" role={progress?.completed ? "status" : "alert"}>{message}</p> : null}
    <div className="adminActions">
      <button className="primaryButton" type="button" disabled={!document || reading || busy || progress?.completed} onClick={() => void importCustomers()}>{reading ? "ファイルを確認中..." : busy ? "登録中..." : "登録を開始 / 再開"}</button>
      <TenantLink className="secondaryButton" href="/customers">顧客一覧へ</TenantLink>
    </div>
  </div>;
}
