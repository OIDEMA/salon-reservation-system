"use client";

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { TenantLink } from "./tenant-link";
import { usePermissions, useTenantSlug } from "./tenant-provider";
import { tenantApiPath } from "@/lib/tenant-routing";

type ImportFile = { version: 1; source: "SALONBOARD"; sourceStoreId: string; expectedCount: number; capturedAt: string; records: unknown[] };
type ImportResult = { expectedCount: number; createdCount: number; skippedCount: number; checksum: string };

export function StaffImportLink() {
  const { can } = usePermissions();
  const tenantSlug = useTenantSlug();
  if (tenantSlug !== "missmrs-takamatsu" || !can("master.write")) return null;
  return <TenantLink className="secondaryButton" href="/staff/import"><Upload size={17} />スタッフを取り込む</TenantLink>;
}

export function StaffImport() {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const [document, setDocument] = useState<ImportFile | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const sequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  useEffect(() => () => { ++sequence.current; requestController.current?.abort(); }, []);

  if (!can("master.write")) return <p role="alert">スタッフデータを取り込む権限がありません。</p>;
  if (tenantSlug !== "missmrs-takamatsu") return <p role="alert">このデータの登録先はミスミセス高松店です。</p>;

  async function chooseFile(file?: File) {
    const current = ++sequence.current;
    setDocument(null); setResult(null); setMessage("");
    if (!file) return;
    setReading(true);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("ファイルは5MB以下で選択してください。");
      const data = JSON.parse(await file.text()) as ImportFile;
      if (!data || data.version !== 1 || data.source !== "SALONBOARD" || data.sourceStoreId !== "H000551123" ||
        !Array.isArray(data.records) || !Number.isInteger(data.expectedCount) || data.expectedCount < 1 || data.expectedCount > 100 || data.records.length !== data.expectedCount) {
        throw new Error("ミスミセス高松店の取込ファイルと件数を確認してください。");
      }
      if (current === sequence.current) setDocument(data);
    } catch (error) {
      if (current === sequence.current) setMessage(error instanceof SyntaxError ? "JSON形式の取込ファイルを選択してください。" : error instanceof Error ? error.message : "ファイルを読み込めませんでした。");
    } finally { if (current === sequence.current) setReading(false); }
  }
  async function importStaff() {
    if (!document || busy || reading) return;
    const controller = new AbortController(); requestController.current = controller;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(tenantApiPath(tenantSlug, "/admin/staff-imports/salonboard"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(document), cache: "no-store", signal: controller.signal
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message ?? `取り込みに失敗しました（${response.status}）。`);
      if (controller.signal.aborted) return;
      setResult(body as ImportResult); setMessage("スタッフデータの取り込みが完了しました。");
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "取り込みに失敗しました。同じファイルで再試行できます。");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <div className="customerImportForm">
    <label className="field"><span>スタッフデータ</span><input type="file" accept=".json,application/json" disabled={busy || reading} onChange={(event) => void chooseFile(event.target.files?.[0])} /></label>
    {document ? <p>{document.expectedCount}件 / 登録先：ミスミセス高松店</p> : null}
    <p>登録済みのスタッフは重複登録せず、現在の設定を保持します。スタッフIDのないデータは氏名・カナで照合します。氏名・カナを変更した場合は重複がないか確認してください。</p>
    {result ? <p aria-live="polite">新規登録 {result.createdCount}件 / 登録済み {result.skippedCount}件 / 合計 {result.expectedCount}件</p> : null}
    {message ? <p className="formMessage" role={result ? "status" : "alert"}>{message}</p> : null}
    <div className="adminActions"><button className="primaryButton" type="button" disabled={!document || reading || busy || Boolean(result)} onClick={() => void importStaff()}>{reading ? "ファイルを確認中..." : busy ? "登録中..." : "登録を開始"}</button><TenantLink className="secondaryButton" href="/staff">スタッフ一覧へ</TenantLink></div>
  </div>;
}
