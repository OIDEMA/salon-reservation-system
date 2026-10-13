"use client";

import { useState } from "react";
import { TenantLink } from "./tenant-link";
import { usePermissions, useTenantSlug } from "./tenant-provider";
import { ChartFields } from "./chart-fields";
import { ChartPhotoGallery, ChartPhotoUpload } from "./chart-photos";
import { chartDate, chartInitialValues, chartPayload, chartPhotoMetadataHeader, chartResponseError, type ChartDetail as ChartDetailData, type ChartFormValues, type ChartPhoto, type ChartPhotoMetadata, type ChartRevision } from "./chart-types";
import { tenantApiPath } from "@/lib/tenant-routing";

function RevisionContent({ revision, timezone }: { revision: ChartRevision; timezone: string }) {
  const rows = [
    ["施術日時", chartDate(revision.treatmentAt, timezone)], ["施術部位", revision.bodyParts.join("、")],
    ["実施した施術の詳細", revision.performedServiceDetail], ["使用機器", revision.machine],
    ["照射出力（J）", revision.outputJ], ["パルス幅", revision.pulseWidth],
    ["脱毛・肌の状態", revision.skinObservations], ["使用した製品・材料", revision.productsMaterials],
    ["アフターケア・お伝えした内容", revision.aftercareNotes], ["次回来店の予定・引き継ぎ", revision.nextVisitPlan]
  ];
  return <dl className="chartRecord">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "未記入"}</dd></div>)}</dl>;
}

export function ChartDetail({ initialChart }: { initialChart: ChartDetailData }) {
  const tenantSlug = useTenantSlug();
  const { can } = usePermissions();
  const canWrite = can("chart.write");
  const [chart, setChart] = useState(initialChart);
  const firstRevision = initialChart.revisions.find((item) => item.revisionNumber === initialChart.currentRevisionNumber)!;
  const [values, setValues] = useState(() => chartInitialValues(firstRevision, undefined, initialChart.timezone));
  const [savedValues, setSavedValues] = useState(() => chartInitialValues(firstRevision, undefined, initialChart.timezone));
  const [recovery, setRecovery] = useState<ChartFormValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState("");
  const [conflict, setConflict] = useState(false);
  const [confirmFinal, setConfirmFinal] = useState(false);
  const [reason, setReason] = useState("");
  const currentRevision = chart.revisions.find((item) => item.revisionNumber === chart.currentRevisionNumber)!;
  const draft = chart.status === "DRAFT";
  const dirty = JSON.stringify(values) !== JSON.stringify(savedValues);
  const locked = busy || conflict;
  const basePath = `/charts/${encodeURIComponent(chart.id)}`;

  async function mutation(path: string, init: RequestInit): Promise<ChartDetailData> {
    if (!canWrite) throw new Error("カルテを更新する権限がありません。");
    const response = await fetch(tenantApiPath(tenantSlug, path), init);
    if (!response.ok) {
      if (response.status === 409) {
        setConflict(true); setConfirmFinal(false);
        throw new Error("別の操作でカルテが更新されました。入力内容は残しています。最新情報を取得して確認してください。");
      }
      throw new Error(await chartResponseError(response));
    }
    return response.json() as Promise<ChartDetailData>;
  }

  function accept(data: ChartDetailData, replaceFields: boolean) {
    setChart(data);
    if (replaceFields) {
      const updated = chartInitialValues(data.revisions.find((item) => item.revisionNumber === data.currentRevisionNumber), undefined, data.timezone);
      setValues(updated); setSavedValues(updated);
    }
  }

  async function action<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (busy) return;
    setBusy(true); setMessage(""); setSuccess("");
    try { return await work(); }
    catch (error) { setMessage(error instanceof TypeError ? "通信に失敗しました。接続を確認して、もう一度お試しください。" : error instanceof Error ? error.message : "カルテの更新に失敗しました。"); }
    finally { setBusy(false); }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || locked || !draft) return;
    await action(async () => {
      const data = await mutation(basePath + "/draft", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: chart.version, ...chartPayload(values, chart.timezone) })
      });
      accept(data, true); setSuccess("下書きを保存しました。"); setConfirmFinal(false);
    });
  }

  async function finalize() {
    if (!canWrite || locked || dirty || !draft) return;
    await action(async () => {
      const data = await mutation(basePath + "/finalize", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: chart.version })
      });
      accept(data, true); setConfirmFinal(false); setSuccess("カルテを確定しました。");
    });
  }

  async function amend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || locked || draft || !reason.trim()) return;
    await action(async () => {
      const data = await mutation(basePath + "/amend", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: chart.version, reason: reason.trim() })
      });
      accept(data, true); setReason(""); setSuccess("訂正用の下書きを作成しました。変更後に保存して確定してください。");
    });
  }

  async function refreshLatest() {
    await action(async () => {
      const response = await fetch(tenantApiPath(tenantSlug, basePath), { cache: "no-store" });
      if (!response.ok) throw new Error(await chartResponseError(response));
      const data = await response.json() as ChartDetailData;
      if (dirty) setRecovery(values);
      accept(data, true);
      if (data.status === "DRAFT") {
        setSuccess("最新情報を表示しました。未保存の入力内容は別に残しています。双方を確認してから操作を続けてください。");
      } else {
        setSuccess("最新情報を取得しました。カルテは確定済みです。変更には訂正理由が必要です。");
      }
      setConflict(false);
    });
  }

  async function upload(file: File, phase: ChartPhoto["phase"], metadata: ChartPhotoMetadata): Promise<boolean> {
    if (!canWrite || locked || !draft) return false;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setMessage("JPEG・PNG・WebPの写真を選択してください。"); return false; }
    if (file.size > 5 * 1024 * 1024 || !file.size) { setMessage("写真は1枚5 MB以下で選択してください。"); return false; }
    if (currentRevision.photos.length >= 10) { setMessage("写真は1つの版につき10枚までです。"); return false; }
    setConfirmFinal(false);
    return Boolean(await action(async () => {
      const query = new URLSearchParams({ expectedVersion: String(chart.version), phase });
      const data = await mutation(basePath + "/photos?" + query, {
        method: "POST", headers: { "Content-Type": file.type, "X-Chart-Photo-Metadata": chartPhotoMetadataHeader(metadata) }, body: file
      });
      accept(data, false); setSuccess("写真と記録を保存しました。");
      return true;
    }));
  }

  async function removePhoto(photoId: string) {
    if (!canWrite || locked || !draft) return;
    setConfirmFinal(false);
    await action(async () => {
      const data = await mutation(basePath + "/photos/" + encodeURIComponent(photoId), {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: chart.version })
      });
      accept(data, false); setSuccess("下書きから写真を削除しました。");
    });
  }

  function updateField(key: keyof ChartFormValues, value: string) { if (!canWrite) return; setValues((existing) => ({ ...existing, [key]: value })); setConfirmFinal(false); }

  return <div className="chartDetailContent">
    <section className="chartContext">
      <div className="chartHeading"><h2>{chart.customerName}</h2><span className={`chartStatus ${draft ? "isDraft" : "isFinalized"}`}>{draft ? "下書き" : "確定済み"} · 第{chart.currentRevisionNumber}版</span></div>
      <dl className="chartContextRows"><div><dt>予約日時</dt><dd>{chartDate(chart.startsAt, chart.timezone)}</dd></div><div><dt>予約メニュー</dt><dd>{chart.serviceName}</dd></div><div><dt>担当者</dt><dd>{chart.staffName ?? "担当者未指定"}</dd></div></dl>
      <div className="chartContextLinks">{can("customer.write") ? <TenantLink href={`/customers/${encodeURIComponent(chart.customerId)}/edit`}>顧客情報へ</TenantLink> : null}{can("reservation.write") ? <TenantLink href={`/reservations/${encodeURIComponent(chart.reservationId)}/edit`}>予約情報へ</TenantLink> : null}<TenantLink href={`/charts?customerId=${encodeURIComponent(chart.customerId)}`}>この顧客のカルテ履歴</TenantLink></div>
    </section>
    {message ? <p className="formMessage error" role="alert">{message}</p> : null}
    {success ? <p className="chartNotice" role="status">{success}</p> : null}
    {canWrite && conflict ? <div className="chartConflict"><p>最新の状態を取得してから操作を続けてください。</p><button type="button" className="secondaryButton" disabled={busy} onClick={refreshLatest}>最新情報を取得</button></div> : null}
    {currentRevision.amendmentReason ? <p className="chartAmendmentReason"><strong>訂正理由</strong>{currentRevision.amendmentReason}</p> : null}
    {canWrite && recovery ? <details className="chartRecovery"><summary>未保存の入力内容</summary><ChartFields values={recovery} onChange={() => {}} readOnly timezone={chart.timezone} />{draft ? <button type="button" className="secondaryButton" disabled={locked} onClick={() => { if (!canWrite) return; setValues(recovery); setRecovery(null); }}>この入力内容を下書きへ戻す</button> : <p className="chartMuted">訂正用の下書きを作成後、入力を戻せます。</p>}</details> : null}
    <section className="chartSection">
      <h3>施術記録</h3>
      {canWrite && draft ? <form className="masterCreateForm" onSubmit={save}>
        <ChartFields values={values} onChange={updateField} disabled={locked} timezone={chart.timezone} />
        <div className="masterCreateActions"><span className="chartSaveHint">{dirty ? "未保存の変更があります。" : "変更は保存されています。"}</span><button type="submit" className="primaryButton" disabled={locked}>{busy ? "処理中..." : "下書きを保存"}</button><button type="button" className="secondaryButton" disabled={locked || dirty || !currentRevision.performedServiceDetail.trim()} onClick={() => setConfirmFinal(true)}>カルテを確定</button></div>
        {!currentRevision.performedServiceDetail.trim() && !dirty ? <p className="chartMuted">確定するには、実施した施術の詳細を入力して保存してください。</p> : null}
        {confirmFinal ? <div className="chartConfirm" role="group" aria-labelledby="chart-finalize-title"><strong id="chart-finalize-title">この内容でカルテを確定しますか？</strong><p>確定後の変更は訂正として記録されます。施術内容と写真を確認してください。</p><div className="chartInlineActions"><button type="button" className="secondaryButton" disabled={locked} onClick={() => setConfirmFinal(false)}>戻る</button><button type="button" className="primaryButton" disabled={locked} onClick={finalize}>確定する</button></div></div> : null}
      </form> : <><RevisionContent revision={currentRevision} timezone={chart.timezone} />{!draft ? <p className="chartMuted">確定：{currentRevision.finalizedAt ? chartDate(currentRevision.finalizedAt, chart.timezone) : "—"} · {currentRevision.finalizedByName ?? "記録者"}</p> : null}</>}
    </section>
    <section className="chartSection"><h3>施術前後の写真</h3>
      <ChartPhotoGallery chartId={chart.id} photos={currentRevision.photos} timezone={chart.timezone} onDelete={canWrite && draft ? removePhoto : undefined} disabled={locked} />
      {canWrite && draft ? <ChartPhotoUpload disabled={locked} photoCount={currentRevision.photos.length} timezone={chart.timezone} onUpload={upload} /> : null}
    </section>
    {canWrite && !draft ? <section className="chartSection"><h3>カルテを訂正</h3><p className="chartMuted">確定済みの内容を残したまま、次の版を下書きとして作成します。</p><form className="chartAmendForm" onSubmit={amend}><label className="createField"><span>訂正理由</span><textarea rows={3} required maxLength={1000} value={reason} disabled={locked} onChange={(event) => setReason(event.target.value)} /></label><button className="secondaryButton" type="submit" disabled={locked || !reason.trim()}>訂正用の下書きを作成</button></form></section> : null}
    <section className="chartSection"><h3>版の履歴</h3><p className="chartMuted">作成者：{currentRevision.createdByName ?? "記録者"} · 最終更新：{chartDate(chart.updatedAt, chart.timezone)}</p>
      {chart.revisions.filter((item) => item.revisionNumber !== chart.currentRevisionNumber).map((revision) => <details className="chartHistory" key={revision.id}><summary>第{revision.revisionNumber}版 · {revision.status === "FINALIZED" ? "確定済み" : "下書き"} · {chartDate(revision.finalizedAt ?? revision.updatedAt, chart.timezone)}</summary>{revision.amendmentReason ? <p className="chartAmendmentReason"><strong>訂正理由</strong>{revision.amendmentReason}</p> : null}<RevisionContent revision={revision} timezone={chart.timezone} /><ChartPhotoGallery chartId={chart.id} photos={revision.photos} timezone={chart.timezone} /><p className="chartMuted">作成者：{revision.createdByName ?? "記録者"} · 確定者：{revision.finalizedByName ?? "—"}</p></details>)}
      {chart.revisions.length === 1 ? <p className="chartMuted">過去の版はありません。</p> : null}
    </section>
  </div>;
}
